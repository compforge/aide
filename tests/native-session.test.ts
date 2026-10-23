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
import type { HarnessAdapter, HarnessEventSink, OpenOptions, HarnessSessionBindingSink } from "../src/host/harness/adapter.ts";
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
  const createAdapter = (): HarnessAdapter => {
    let sink: HarnessEventSink;
    return { harness: "test", capabilities: { prompt: {} },
      async open(options, events, binding) {
        opened.push(options); sink = events;
        binding({ identity: { id: options.sessionId ?? "native-one" } });
        return { harness: "test", handleId: `temporary-${opened.length}`, resumed: !!options.sessionId };
      },
      async sendTurn(_handle, input) {
        const saved = await resources.get<unknown, { agent: AgentStatus }>(scope.resourceRef!);
        assert.equal(saved!.status.agent.session!.id, "native-one");
        prompts.push(input.blocks);
        sink({ kind: "agent_message", invocationId: input.invocationId, payload: { messageId: input.messageId + "-reply", phase: "final", content: [{ type: "text", text: "done" }] } });
        sink({ kind: "state_update", invocationId: input.invocationId, payload: { state: "idle", stopReason: "end_turn" } });
        return { accepted: true, effective: "new_turn" };
      }, async cancel() {}, async close() {},
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

for (const late of [false, true]) test(`binding persistence failure ${late ? "after native completion" : "during open"} is reported`, async t => {
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
      let publish: HarnessSessionBindingSink;
      return { harness: "test", capabilities: { prompt: {} },
        async open(_options, events, binding) {
          sink = events; publish = binding;
          if (!late) publish({ identity: { id: "native" } });
          return { harness: "test", handleId: "temporary" };
        },
        async sendTurn(_handle, input) {
          sends++;
          publish({ identity: { id: "native" } });
          sink({ kind: "state_update", invocationId: input.invocationId, payload: { state: "idle", stopReason: "end_turn" } });
          return { accepted: true, effective: "new_turn" };
        }, async cancel() {}, async close() {},
      };
    } });
  t.after(() => service.close());
  await assert.rejects(service.invoke(scope, request), /binding storage unavailable/);
  assert.equal(sends, late ? 1 : 0);
  assert.equal((await resources.get<unknown, { agent?: AgentStatus }>(scope.resourceRef!))!.status.agent, undefined);
  unavailable = false;
  assert.equal((await service.invoke({ ...scope, executionId: "later-input" }, request)).state, "success");
  assert.equal((await resources.get<unknown, { agent: AgentStatus }>(scope.resourceRef!))!.status.agent.session!.id, "native");
});

test("a requested Codex session cannot silently fall back to a new thread", async () => {
  const methods: string[] = [];
  await assert.rejects(openCodexThread({ async request(method) { methods.push(method); throw new Error("thread not found"); } },
    { cwd: "/workspace", sessionId: "lost-native-thread" }), /thread not found/);
  assert.deepEqual(methods, ["thread/resume"]);
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
        async open(options, events, binding) {
          sink = events; live++;
          const id = options.sessionId ?? `native-${++created}`;
          if (options.sessionId) reopened.push(options.sessionId);
          binding({ identity: { id } });
          return { harness: "test", handleId: id };
        }, async sendTurn(_handle, input) {
          sink({ kind: "state_update", invocationId: input.invocationId, payload: { state: "idle", stopReason: "end_turn" } });
          return { accepted: true, effective: "new_turn" };
        }, async cancel() {}, async close() { live--; },
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
