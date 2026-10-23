import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { AgentStatus, ResourceClient, ResourceDefinition } from "@compforge/aide-plugin";
import { AgentStatusSchema } from "../plugins/personal/session.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { ResourceSession } from "../src/host/harness/session.ts";
import { ExecutionService } from "../src/host/runtime/execution.ts";
import type { ExecutionScope } from "../src/protocol/verbs.ts";
import type { Harness, HarnessEventSink, OpenOptions, SessionReferenceSink } from "../src/host/harness/adapter.ts";
import { openCodexThread } from "../src/host/harness/codex/thread.ts";

const TYPE = { apiVersion: "example.dev/v1", kind: "Document" };
const definition: ResourceDefinition = { type: TYPE, schema: { spec: z.object({}),
  status: z.object({ agent: AgentStatusSchema.optional(), progress: z.string().optional() }).strict() } };
async function setup(t: { after(fn: () => void | Promise<void>): void }) {
  const home = mkdtempSync(join(tmpdir(), "aide-native-session-"));
  const store = new PluginResourceStore({ home, pluginInstanceId: "example" });
  store.storage.register("example", [definition]);
  const resources = createResourceClient(store);
  const resource = await resources.create(TYPE, { name: "one", spec: {}, status: { progress: "initial" } });
  const scope: ExecutionScope = { pluginInstanceId: "example", namespace: resource.metadata.namespace, executionId: "execution",
    resourceRef: { ...TYPE, namespace: resource.metadata.namespace, name: resource.metadata.name, uid: resource.metadata.uid } };
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return { home, resources, scope, resource, store };
}
const target = { id: "configured", harness: "test" };
const request = { verb: "harness" as const, input: { title: "native", prompt: "only this input", timeoutMs: 3000, agentKey: "agent" } };

test("resource native binding preserves sibling status under concurrent updates and fences resource recreation", async t => {
  const { resources, scope, store } = await setup(t);
  let conflict = true;
  const racing: ResourceClient = { ...resources, async patchStatus(resource, patch) {
    if (conflict) {
      conflict = false;
      const latest = (await resources.get<unknown, { progress: string }>(scope.resourceRef!))!;
      await resources.patchStatus(latest, { progress: "concurrent" });
    }
    return resources.patchStatus(resource, patch);
  } };
  const owner = new ResourceSession(racing, scope, "agent", target.id, target.harness);
  await owner.write({ harness: "native-wire-name", harnessSessionId: "native-one" });
  const saved = await resources.get<unknown, { agent: AgentStatus; progress: string }>(scope.resourceRef!);
  assert.deepEqual(saved!.status, { progress: "concurrent", agent: { harness: "test", targetId: "configured", session: { id: "native-one" } } });
  assert.equal((await owner.read())!.harnessSessionId, "native-one");
  assert.equal(await new ResourceSession(resources, scope, "agent", "another", "test").read(), undefined);
  assert.equal(await new ResourceSession(resources, scope, "agent", target.id, "another").read(), undefined);
  await resources.delete(TYPE, "one", scope.namespace);
  await assert.rejects(owner.write({ harness: "test", harnessSessionId: "deleting" }), /deleted/);
  store.finalizeDeletion(TYPE, "one", scope.namespace);
  await resources.create(TYPE, { name: "one", spec: {} });
  await assert.rejects(owner.write({ harness: "test", harnessSessionId: "late-old-binding" }), /missing|deleted|UID|uid/i);
  assert.equal((await resources.get<unknown, { agent?: AgentStatus }>({ ...TYPE, name: "one", namespace: scope.namespace }))!.status.agent, undefined);
});

/** @case Native session identity is durable before prompt dispatch; restarting Aide restores it without any event replay. */
test("execution resumes solely from resource status and keeps the native ID separate from live handles", async t => {
  const { home, resources, scope } = await setup(t);
  const opened: OpenOptions[] = [];
  const prompts: unknown[] = [];
  const createAdapter = (): Harness => {
    let sink: HarnessEventSink;
    return { harness: "test", capabilities: { prompt: {} },
      async resume(options, events, reference) { return this.create(options, events, reference); },
      async create(options, events, binding) {
        opened.push(options); sink = events;
        binding({ identity: { id: options.sessionId ?? "native-one" } });
        return { harness: "test", handleId: `temporary-${opened.length}`, resumed: !!options.sessionId };
      },
      async prompt(_handle, input) {
        const saved = await resources.get<unknown, { agent: AgentStatus }>(scope.resourceRef!);
        assert.equal(saved!.status.agent.session!.id, "native-one");
        prompts.push(input.blocks);
        sink({ kind: "agent_message", invocationId: input.invocationId, payload: { messageId: input.messageId + "-reply", phase: "final", content: [{ type: "text", text: "done" }] } });
        sink({ kind: "state_update", invocationId: input.invocationId, payload: { state: "idle", stopReason: "end_turn" } });
        return { accepted: true, effective: "new_turn" };
      }, async abort() {}, async close() {},
    };
  };
  const open = () => new ExecutionService(home, { cwd: home, targets: [target], defaultTargetId: target.id,
    resolveTarget: () => target, createAdapter, resources: () => resources });
  let service = open();
  t.after(() => service.close());
  assert.equal((await service.invoke(scope, request)).state, "success");
  assert.equal((await service.invoke({ ...scope, executionId: "followup" }, request)).state, "success");
  assert.equal(opened.length, 1, "Followup uses the live native session");
  const competitor = open();
  await assert.rejects(competitor.invoke(scope, request), /already active/);
  await competitor.close();
  const ids = service.listHarnessInvocations().map(i => i.invocationId);
  assert.equal(service.view([ids[0]!]).invocationSummaries.length, 1);
  await service.close(); service = open();
  assert.equal(service.view(ids).messages.size, 0);
  assert.equal((await service.invoke({ ...scope, executionId: "resumed" }, request)).state, "success");
  assert.equal(opened[1]!.sessionId, "native-one");
  assert.equal(opened[1]!.resumeState, undefined, "An ID-only adapter needs no fabricated recovery payload");
  assert.deepEqual(prompts, Array.from({ length: 3 }, () => [{ type: "text", text: "only this input" }]));
  assert.equal(existsSync(join(home, "harness", "events.jsonl")), false);
  assert.equal(existsSync(join(home, "harness", "meta.json")), false);
});

for (const scenario of ["open", "completed", "cancelled"] as const) test(`reference persistence failure during ${scenario} releases the native runtime`, async t => {
  const late = scenario !== "open";
  const { home, resources, scope } = await setup(t);
  let sends = 0;
  let unavailable = true;
  const broken: ResourceClient = { ...resources, async patchStatus(resource, patch) {
    if (unavailable) throw new Error("binding storage unavailable");
    return resources.patchStatus(resource, patch);
  } };
  const service = new ExecutionService(home, { cwd: home, targets: [target], defaultTargetId: target.id, resolveTarget: () => target,
    resources: () => broken, createAdapter() {
      let sink: HarnessEventSink;
      let publish: SessionReferenceSink;
      return { harness: "test", capabilities: { prompt: {} },
        async resume(options, events, reference) { return this.create(options, events, reference); },
        async create(_options, events, binding) {
          sink = events; publish = binding;
          if (!late) publish({ identity: { id: "native" } });
          return { harness: "test", handleId: "temporary" };
        },
        async prompt(_handle, input) {
          sends++;
          publish({ identity: { id: "native" } });
          sink({ kind: "state_update", invocationId: input.invocationId, payload: { state: "idle", stopReason: unavailable && scenario === "cancelled" ? "cancelled" : "end_turn" } });
          return { accepted: true, effective: "new_turn" };
        }, async abort() {}, async close() {},
      };
    } });
  t.after(() => service.close());
  if (scenario === "cancelled") {
    const result = await service.invoke(scope, request);
    assert.equal(result.state, "success");
    if (result.state === "success") assert.equal((result.value as { result: { stopReason: string } }).result.stopReason, "cancelled");
  } else await assert.rejects(service.invoke(scope, request), /binding storage unavailable/);
  assert.equal(sends, late ? 1 : 0);
  assert.equal((await resources.get<unknown, { agent?: AgentStatus }>(scope.resourceRef!))!.status.agent, undefined);
  unavailable = false;
  assert.equal((await service.invoke({ ...scope, executionId: "later-input" }, request)).state, "success");
  assert.equal(sends, late ? 2 : 1, "the very next input reaches Harness once storage recovers");
  assert.equal((await resources.get<unknown, { agent: AgentStatus }>(scope.resourceRef!))!.status.agent.session!.id, "native");
});

test("a requested Codex session cannot silently fall back to a new thread", async () => {
  const methods: string[] = [];
  await assert.rejects(openCodexThread({ async request(method) { methods.push(method); throw new Error("thread not found"); } },
    { cwd: "/workspace", sessionId: "lost-native-thread" }), /thread not found/);
  assert.deepEqual(methods, ["thread/resume"]);
});

/** @case Session operations cross the verb boundary without fabricating inference or recovery history. */
test("Harness verbs create, close and resume through the provider contract", async t => {
  const { home, resources, scope } = await setup(t);
  const calls: string[] = [];
  const service = new ExecutionService(home, { cwd: home, targets: [target], defaultTargetId: target.id,
    resolveTarget: () => target, resources: () => resources, createAdapter: () => ({ harness: "test", capabilities: { prompt: {} },
      async create(_options, _events, reference) {
        calls.push("create"); reference({ identity: { id: "native" } });
        return { harness: "test", handleId: "live" };
      },
      async resume(options, _events, reference) {
        calls.push(`resume:${options.sessionId}`); reference({ identity: { id: options.sessionId } });
        return { harness: "test", handleId: "resumed" };
      },
      async prompt() { throw new Error("session operations must not manufacture a prompt"); },
      async abort() { calls.push("abort"); }, async close() { calls.push("close"); },
    }) });
  t.after(() => service.close());
  const operate = (input: import("@compforge/aide-plugin").HarnessOperationInput) => service.invoke(scope, { verb: "harness", input });
  assert.equal((await operate({ operation: "create", agentKey: "agent", timeoutMs: 1000 })).state, "success");
  assert.equal(service.listHarnessInvocations().length, 0);
  assert.equal((await resources.get<unknown, { agent: AgentStatus }>(scope.resourceRef!))!.status.agent.session!.id, "native");
  await operate({ operation: "close", timeoutMs: 1000 });
  await operate({ operation: "resume", session: { id: "native" }, agentKey: "agent", timeoutMs: 1000 });
  assert.deepEqual(calls, ["create", "close", "resume:native"]);
  assert.equal(service.listHarnessInvocations().length, 0, "session operations create no inference invocation");
});

test("cancelled cold startup failure does not retain a failed runtime", async t => {
  const { home, resources, scope } = await setup(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let opened!: () => void;
  const opening = new Promise<void>(resolve => { opened = resolve; });
  let attempts = 0, sends = 0;
  const service = new ExecutionService(home, { cwd: home, targets: [target], defaultTargetId: target.id,
    resolveTarget: () => target, resources: () => resources, createAdapter() {
      let sink: HarnessEventSink;
      return { harness: "test", capabilities: { prompt: {} },
        async create(_options, events, reference) {
          sink = events;
          if (++attempts === 1) { opened(); await gate; throw new Error("native startup failed"); }
          reference({ identity: { id: "native" } }); return { harness: "test", handleId: "live" };
        },
        async resume(options, events, reference) { return this.create(options, events, reference); },
        async prompt(_ref, input) {
          sends++; sink({ kind: "state_update", invocationId: input.invocationId, payload: { state: "idle", stopReason: "end_turn" } });
          return { accepted: true, effective: "new_turn" };
        }, async abort() {}, async close() {},
      };
    } });
  t.after(async () => { release(); await service.close(); });
  const first = service.invoke(scope, request);
  await opening; assert.equal(service.cancelHarnessInvocation(), true); release();
  assert.equal((await first).state, "dismissed");
  assert.equal((await service.invoke({ ...scope, executionId: "next" }, request)).state, "success");
  assert.equal(attempts, 2); assert.equal(sends, 1);
});

test("followUp receipts are scoped to the owning resource and do not complete inference", async t => {
  const { home, resources, scope } = await setup(t);
  let sink!: HarnessEventSink;
  let invocationId = "";
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const service = new ExecutionService(home, { cwd: home, targets: [target], defaultTargetId: target.id,
    resolveTarget: () => target, resources: () => resources, createAdapter: () => ({ harness: "test", capabilities: { prompt: {} },
      async create(_options, events, reference) { sink = events; reference({ identity: { id: "native" } }); return { harness: "test", handleId: "live" }; },
      async resume(options, events, reference) { return this.create(options, events, reference); },
      async prompt(_ref, input) { invocationId = input.invocationId; started(); return { accepted: true, effective: "new_turn" }; },
      async followUp(_ref, input) {
        sink({ kind: "input_delivery_update", invocationId, payload: { messageId: input.messageId, state: "applied" } });
        return { accepted: true, effective: "followUp" };
      },
      async abort() { sink({ kind: "state_update", invocationId, payload: { state: "idle", stopReason: "cancelled" } }); }, async close() {},
    }) });
  t.after(() => service.close());
  const running = service.invoke(scope, request);
  await active;
  const followup = { verb: "harness" as const, input: { operation: "followUp" as const, invocationId, messageId: "followup", prompt: "next", timeoutMs: 1000 } };
  await assert.rejects(service.invoke({ ...scope, resourceRef: { ...scope.resourceRef!, uid: "another-resource" } }, followup), /owned by the calling resource/);
  await assert.rejects(service.invoke({ ...scope, pluginInstanceId: "another-plugin" }, followup), /owned by the calling resource/);
  const receipt = await service.invoke(scope, followup);
  assert.deepEqual(receipt, { state: "success", value: { outcome: "accepted", reason: undefined } });
  assert.equal(service.listHarnessInvocations()[0]!.phase, "running");
  const view = service.view([invocationId]);
  assert.equal(view.harnessInputs.get("followup")!.delivery, "followUp");
  assert.equal(view.harnessInputs.get("followup")!.deliveryOutcome, "applied");
  const unsupported = await service.invoke(scope, { ...followup, input: { ...followup.input, operation: "steer", messageId: "unsupported" } });
  assert.deepEqual(unsupported, { state: "success", value: { outcome: "rejected", reason: "steer_unsupported" } });
  await assert.rejects(service.invoke(scope, { ...followup, input: { ...followup.input, harnessTargetId: "wrong-target" } }), /does not match/);
  const cancelled = await service.invoke({ ...scope, controllerName: "intake" }, { verb: "harness", input: { operation: "abort", invocationId, timeoutMs: 1000 } });
  assert.deepEqual(cancelled, { state: "success", value: { outcome: "accepted" } });
  assert.equal((await running).state, "dismissed");
});

/** @case Idle-handle eviction cannot erase durable native continuity or interfere with active contexts. */
test("idle native handles are bounded and evicted resources resume through their saved identity", async t => {
  const { home, resources, scope } = await setup(t);
  let created = 0;
  let live = 0;
  const reopened: string[] = [];
  const service = new ExecutionService(home, { cwd: home, targets: [target], defaultTargetId: target.id,
    resolveTarget: () => target, resources: () => resources, createAdapter() {
      let sink: HarnessEventSink;
      return { harness: "test", capabilities: { prompt: {} },
        async resume(options, events, reference) { return this.create(options, events, reference); },
        async create(options, events, binding) {
          sink = events; live++;
          const id = options.sessionId ?? `native-${++created}`;
          if (options.sessionId) reopened.push(options.sessionId);
          binding({ identity: { id } });
          return { harness: "test", handleId: id };
        }, async prompt(_handle, input) {
          sink({ kind: "state_update", invocationId: input.invocationId, payload: { state: "idle", stopReason: "end_turn" } });
          return { accepted: true, effective: "new_turn" };
        }, async abort() {}, async close() { live--; },
      };
    } });
  t.after(() => service.close());
  await service.invoke(scope, request);
  for (let i = 0; i < 45; i++) {
    const resource = await resources.create(TYPE, { name: `other-${i}`, spec: {} });
    await service.invoke({ ...scope, executionId: `run-${i}`, resourceRef: { ...scope.resourceRef!, name: resource.metadata.name, uid: resource.metadata.uid } }, request);
  }
  assert.equal(live, 40);
  assert.equal(service.listHarnessInvocations().length, 40);
  await service.invoke({ ...scope, executionId: "after-eviction" }, request);
  assert.deepEqual(reopened, ["native-1"]);
  assert.equal(created, 46);
  assert.equal(live, 40);
});
