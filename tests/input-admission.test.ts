import { newHarnessError } from "@compforge/aide-plugin";
import { committedStatus } from "./fixtures/resource-write.ts";
import { ROUTE_TYPE, ROUTE_NAME } from "../plugins/personal/route/model.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { PluginContext, ReconcileContext, ResourceClient } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { deliver } from "../plugins/personal/route/delivery.ts";
import { runInput, nextInputs, finalizeExecution } from "../plugins/personal/loop.ts";
import { resourceRef, changeAssessment } from "../plugins/personal/input/state.ts";
import { assessInput } from "../plugins/personal/topic/assess.ts";
import { reconcileChief } from "../plugins/personal/topic/reconcile.ts";
import type { TopicResource } from "../plugins/personal/topic/model.ts";
import { InputAttention } from "../plugins/personal/input/model.ts";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-admission-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected Work"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const context = { resources, logger, instance: { config: {} } } as unknown as PluginContext;
  const current = (c: TopicResource) => aide.topics.resource(c.spec.id)!;
  const input = async (id: string, topics: TopicResource[], attention = InputAttention.Normal) => {
    const fact = aide.topics.inputStore.submit("fixture", id, { origin: "source", originId: "fixture", text: id, attention });
    await deliver(context, fact, topics.map(c => c.metadata), "Shared material");
    return aide.topics.inputStore.get(id)!;
  };
  const prompts: { id: string; prompt: string }[] = [];
  const execution = (id: string, onPrompt?: () => Promise<void>) => ({ executionId: id, withContext() { return this; }, verbs: { async action() { return { state: "success", value: { streaming: false } }; }, async harness(args: { operation?: string; prompt?: string }) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: `session-${id}` } };
    prompts.push({ id, prompt: args.prompt! }); await onPrompt?.();
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } } as unknown as ReconcileContext);
  return { aide, resources, context, current, input, prompts, execution };
}

/** @case One current Topic rejects fanout without partially routing the Input. */
test("Routing requires one current Topic", async t => {
  const f = fixture(t), a = await f.aide.topics.ensure("a"), b = await f.aide.topics.ensure("b");
  await assert.rejects(f.input("shared", [a, b]), /exactly one/);
  assert.equal(f.aide.topics.inputStore.get("shared")!.status.topic, undefined);
  await f.input("only-a", [a]); await f.input("only-b", [b]);
  await Promise.all([a, b].map(c => reconcileChief(f.context, f.execution(c.spec.id), f.current(c))));
  assert.equal(f.prompts.length, 2);
  assert.equal(f.aide.topics.inputStore.get("only-a")!.status.assess!.executionId, "a");
  assert.equal(f.aide.topics.inputStore.get("only-b")!.status.assess!.executionId, "b");
});

function mockRunning(f: ReturnType<typeof fixture>, dispatch: (args: unknown) => Promise<unknown>) {
  f.aide.runtime.plugins.listHarnessInvocations = () => ["a", "b"].map(id => ({ executionId: id, invocationId: `invocation-${id}`, phase: "running" })) as any;
  f.aide.runtime.plugins.executionVerbs = (() => ({ harness: dispatch })) as any;
}
const intake = (c: TopicResource) => ({ pluginInstanceId: "personal", namespace: c.metadata.namespace, executionId: `intake-${c.spec.id}`, resourceRef: resourceRef(c) });
async function running(f: ReturnType<typeof fixture>, c: TopicResource) {
  return f.resources.patchStatus(f.current(c), { execution: { id: c.spec.id, startedAt: new Date().toISOString() }, agent: { harness: "chief", sessionId: `native-${c.spec.id}` } });
}

/** @case Native steer and followUp must use the Chief execution ID, not the intake Reconcile execution ID. */
test("Steer and followUp racing within one root dispatch once and retain uncertain admission across recovery", async t => {
  const f = fixture(t), a = await f.aide.topics.ensure("a"), b = await f.aide.topics.ensure("b");
  await running(f, a); await f.input("shared", [a], InputAttention.Immediate);
  let count = 0;
  mockRunning(f, async () => { count++; return { state: "success", value: { outcome: "accepted" } }; });
  const results = await Promise.all([f.aide.personal.submitTopic(intake(a), { inputId: "shared", operation: "steer" }),
    f.aide.personal.submitTopic(intake(a), { inputId: "shared", operation: "followUp" })]);
  assert.equal(count, 1); assert.equal(results.filter(r => r.accepted).length, 1);
  const receipt = f.aide.topics.inputStore.get("shared")!.status.assess!;
  assert.ok(["a", "b"].includes(receipt.executionId!));
  await f.aide.personal.recoverInterrupted();
  assert.equal(f.aide.topics.inputStore.get("shared")!.status.assess!.executionId, receipt.executionId);
  for (const c of [a, b]) assert.deepEqual(await nextInputs(f.resources, f.current(c), 8), []);
  assert.equal(count, 1);
});

test("An in-flight initial prompt loses safely to a competing prompt admission", async t => {
  const f = fixture(t), a = await f.aide.topics.ensure("a");
  await f.input("shared", [a]);
  let raced = false;
  const resources: ResourceClient = { ...f.resources, async commit(writes) {
    if (!raced) { raced = true; await runInput(f.context, f.execution("winner"), f.current(a), "chief", "shared", "shared"); }
    return f.resources.commit(writes);
  } };
  await runInput({ ...f.context, resources }, f.execution("loser"), f.current(a), "chief", "shared", "shared");
  assert.equal(f.prompts.length, 1);
  assert.equal(f.aide.topics.inputStore.get("shared")!.status.assess!.executionId, "winner");
});

for (const outcome of ["rejected", "unknown", "completed"] as const) test(`Chief notification ${outcome} preserves the appropriate admission evidence`, async t => {
  const f = fixture(t), a = await f.aide.topics.ensure("a"); await running(f, a);
  const fact = await f.input("fact", [a]);
  mockRunning(f, async () => {
    if (outcome === "unknown") throw new Error("transport timed out");
    if (outcome === "completed") await assessInput(f.resources, f.current(a), "a", { inputId: "fact", summary: "Already handled" });
    return { state: "success", value: { outcome: "rejected", reason: "not_running" } };
  });
  const submit = f.aide.personal.submitTopic(intake(a), { inputId: "fact", operation: "followUp" });
  if (outcome === "unknown") await assert.rejects(submit, /timed out/); else await submit;
  const receipt = f.aide.topics.inputStore.get("fact")!.status.assess!;
  assert.equal(receipt.executionId, outcome === "rejected" ? undefined : "a");
  assert.equal((await nextInputs(f.resources, f.current(a), 8)).length, outcome === "rejected" ? 1 : 0);
  if (outcome === "completed") assert.equal(receipt.result!.summary, "Already handled");
  if (outcome === "unknown") assert.match(receipt.lastError!, /timed out/);
  await changeAssessment(f.resources, fact, "someone-else", { executionId: undefined });
  assert.deepEqual(f.aide.topics.inputStore.get("fact")!.status.assess, receipt);
});

/** @case Reparented in-flight Input is readable in the new tree but never activates another Chief. */
test("Grouping and interrupted prompt keep admission global; Deferred claims wait for selection", async t => {
  const f = fixture(t), a = await f.aide.topics.ensure("a"), b = await f.aide.topics.ensure("b");
  await f.input("fact", [a]); const deferred = await f.input("deferred", [b], InputAttention.Deferred);
  assert.equal(deferred.status.assess!.executionId, undefined);
  await runInput(f.context, f.execution("a", async () => {
    const latest = f.current(a);
    await f.resources.replace(latest, { ...latest.spec, parentRef: resourceRef(b) }, latest.status);
    assert.deepEqual((await nextInputs(f.resources, f.current(b), 8)).map(i => i.metadata.name), ["deferred"]);
    assert.ok(f.aide.topics.inputs("b").some(i => i.metadata.name === "fact"));
    throw new Error("connection lost after dispatch");
  }), f.current(a), "chief", "fact", "fact");
  await finalizeExecution(f.context, f.current(a), "a");
  const receipt = f.aide.topics.inputStore.get("fact")!.status.assess!;
  assert.equal(receipt.executionId, "a"); assert.match(receipt.lastError!, /connection lost/);
  assert.deepEqual(f.aide.topics.inputStore.get("deferred")!.status.assess, { topic: resourceRef(b) });
  const originalList = f.aide.topics.inputStore.list;
  f.aide.topics.inputStore.list = () => { throw new Error("Material lookup must use Topic indexes"); };
  assert.equal(f.aide.topics.inputs("b").length, 2);
  f.aide.topics.inputStore.list = originalList;
});

/** @case Rejection bookkeeping cannot repeatedly wake intake while the same Chief is running. */
test("Only routing and completion wake assessment watchers, not claim or rejection bookkeeping", async t => {
  const { assignmentWatch } = await import("../plugins/personal/input/state.ts");
  const f = fixture(t), a = await f.aide.topics.ensure("a");
  const fact = await f.input("fact", [a]);
  const watch = assignmentWatch("assess", "Topic");
  await running(f, a);
  const claimed = await f.resources.patchStatus(fact, { assess: { executionId: "a", startedAt: new Date().toISOString() } });
  const rejected = await f.resources.patch(claimed, { type: "json", value: [{ op: "replace", path: "/status/assess", value: { topic: resourceRef(a) } }] });
  const completed = await f.resources.patchStatus(rejected, { assess: { completedAt: new Date().toISOString() } });
  assert.deepEqual(await watch.handler.update!({ oldObject: fact, newObject: claimed } as any), []);
  assert.deepEqual(await watch.handler.update!({ oldObject: claimed, newObject: rejected } as any), []);
  assert.deepEqual(await watch.handler.update!({ oldObject: rejected, newObject: completed } as any), [{ name: a.metadata.name, namespace: a.metadata.namespace }]);
  await assert.rejects(f.resources.patch(completed, { type: "json", value: [{ op: "replace", path: "/status/assess", value: {} }] }), /already completed/);
});

/** @case Failure only releases the binding; a later independent admission creates the next session without replay. */
for (const closeFails of [false, true]) test(`Compaction failure unbinds Chief and preserves its receipt (close fails: ${closeFails})`, async t => {
  const f = fixture(t), topic = await f.aide.topics.ensure("compaction");
  await f.input("failed", [topic]);
  const calls: { operation: string; sessionId?: string }[] = [];
  const agent = { harness: "chief", sessionId: "old-session" };
  await f.resources.patchStatus(f.current(topic), { agent });
  const execution = { executionId: "failed-run", verbs: { async harness(args: { operation?: string; sessionId?: string }) {
    calls.push({ operation: args.operation ?? "prompt", sessionId: args.sessionId });
    if (args.operation === "close") {
      assert.equal(f.current(topic).status.agent, undefined);
      assert.equal(f.current(topic).status.execution, null);
      assert.equal(f.aide.topics.inputStore.get("failed")!.status.assess!.lastError, "summary token cap");
      if (closeFails) throw new Error("runtime cleanup unavailable");
      return { state: "success", value: { outcome: "accepted" } };
    }
    // A transport may omit agent; the admitted identity remains known to the caller.
    throw newHarnessError("harness_compaction_failed", "summary token cap");
  } } } as unknown as ReconcileContext;
  assert.equal(await runInput(f.context, execution, f.current(topic), "chief", "failed", "failed"), false);
  assert.deepEqual(calls, [{ operation: "prompt", sessionId: "old-session" }, { operation: "close", sessionId: "old-session" }]);
  const receipt = f.aide.topics.inputStore.get("failed")!.status.assess!;
  assert.deepEqual(receipt.agent, agent);
  assert.equal(receipt.executionId, "failed-run");
  assert.equal(receipt.lastError, "summary token cap");
  assert.equal(receipt.completedAt, undefined);
  assert.deepEqual(await nextInputs(f.resources, f.current(topic), 8), []);
  assert.equal(f.current(topic).status.lastError, "summary token cap");

  await f.input("fresh", [topic]);
  assert.deepEqual((await nextInputs(f.resources, f.current(topic), 8)).map(i => i.metadata.name), ["fresh"]);
  await runInput(f.context, f.execution("fresh-run", async () => {
    assert.equal(f.current(topic).status.agent?.sessionId, "session-fresh-run");
    await assessInput(f.resources, f.current(topic), "fresh-run", { inputId: "fresh", summary: "Handled" });
  }), f.current(topic), "chief", "fresh", "fresh");
  assert.deepEqual(f.aide.topics.inputStore.get("failed")!.status.assess, receipt);
  assert.ok(f.aide.topics.inputStore.get("fresh")!.status.assess?.completedAt);
});

for (const outcome of ["error", "cancelled", "timeout"] as const) test(`${outcome} retains the existing Agent binding`, async t => {
  const f = fixture(t), topic = await f.aide.topics.ensure("retained");
  await f.input("fact", [topic]);
  const agent = { harness: "chief", sessionId: "retained-session" };
  await f.resources.patchStatus(f.current(topic), { agent });
  const execution = { executionId: "run", verbs: { async harness(args: { operation?: string }) {
    assert.equal(args.operation, undefined);
    if (outcome === "error") throw newHarnessError("harness_execution_failed", "summary token cap", agent);
    return { state: outcome === "cancelled" ? "dismissed" : "timeout", agent };
  } } } as unknown as ReconcileContext;
  await runInput(f.context, execution, f.current(topic), "chief", "fact", "fact");
  assert.deepEqual(f.current(topic).status.agent, agent);
});

for (const race of ["status", "session", "execution"] as const) test(`Compaction cleanup rechecks ${race} after a finalization conflict`, async t => {
  const f = fixture(t), topic = await f.aide.topics.ensure("race");
  const agent = { harness: "chief", sessionId: "old-session" };
  await f.resources.patchStatus(f.current(topic), { agent, execution: { id: "old-run", startedAt: new Date().toISOString() } });
  const owner = f.current(topic);
  let raced = false;
  const resources: ResourceClient = { ...f.resources, async commit(writes) {
    if (!raced && writes.some(write => committedStatus(write)?.execution === null)) {
      raced = true;
      await f.resources.patchStatus(f.current(topic), race === "status" ? { idleReviewCount: 7 }
        : race === "session" ? { agent: { harness: "chief", sessionId: "new-session" } }
        : { execution: { id: "new-run", startedAt: new Date().toISOString() } });
    }
    return f.resources.commit(writes);
  } };
  const released = await finalizeExecution({ ...f.context, resources }, owner, "old-run", "summary token cap",
    newHarnessError("harness_compaction_failed", "summary token cap", agent));
  assert.ok(raced);
  if (race === "status") {
    assert.deepEqual(released, agent);
    assert.equal(f.current(topic).status.agent, undefined);
    assert.equal(f.current(topic).status.idleReviewCount, 7);
  } else {
    assert.equal(released, undefined);
    assert.equal(f.current(topic).status.agent?.sessionId, race === "session" ? "new-session" : "old-session");
    if (race === "execution") assert.equal(f.current(topic).status.execution?.id, "new-run");
  }
});

test("Route compaction failure does not schedule replay of its failed Input", async t => {
  const f = fixture(t);
  const route = await f.resources.create<Record<string, never>, import("../plugins/personal/loop.ts").LoopStatus>(ROUTE_TYPE, { name: ROUTE_NAME, spec: {} });
  f.aide.topics.inputStore.submit("fixture", "route-failed", { origin: "source", originId: "fixture", text: "route-failed" });
  const agent = { harness: "route", sessionId: "route-session" };
  const calls: string[] = [];
  const execution = { executionId: "route-run", verbs: { async harness(args: { operation?: string }) {
    calls.push(args.operation ?? "prompt");
    if (args.operation) return { state: "success", value: { outcome: "accepted" }, agent };
    throw newHarnessError("harness_compaction_failed", "summary token cap", agent);
  } } } as unknown as ReconcileContext;
  await runInput(f.context, execution, route, "route", "route-failed", "route-failed");
  const latest = (await f.resources.get<unknown, import("../plugins/personal/loop.ts").LoopStatus>(resourceRef(route)))!;
  assert.equal(latest.status.agent, undefined);
  assert.deepEqual(calls, ["create", "prompt", "close"]);
  const receipt = f.aide.topics.inputStore.get("route-failed")!.status.route!;
  assert.equal(receipt.lastError, "summary token cap");
  assert.equal(receipt.nextAttemptAt, undefined);
  assert.deepEqual(await nextInputs(f.resources, latest, 8), []);
});

/** @case A successful immediate interruption preserves maintenance as pending without replaying completed business. */
test("Immediate business can interrupt internal maintenance and unfinished maintenance remains pending", async t => {
  const { createReviewInput } = await import("../plugins/personal/topic/review.ts");
  const { maintenanceAgenda } = await import("../plugins/personal/topic/maintenance.ts");
  const f = fixture(t), root = await f.aide.topics.ensure("a");
  const maintenance = await createReviewInput(f.context, root, new Date().toISOString(), await maintenanceAgenda(f.resources, []));
  await running(f, root);
  await f.resources.patchStatus(f.current(root), { execution: { ...f.current(root).status.execution!, inputOrigin: "aide:review" } });
  await f.resources.patchStatus(maintenance, { assess: { ...maintenance.status.assess, executionId: "a", startedAt: new Date().toISOString() } });
  await f.input("urgent", [root], InputAttention.Immediate);
  mockRunning(f, async () => ({ state: "success", value: { outcome: "accepted" } }));
  assert.equal((await f.aide.personal.submitTopic(intake(root), { inputId: "urgent", operation: "steer" })).accepted, true);
  await assessInput(f.resources, f.current(root), "a", { inputId: "urgent", summary: "Answered" });
  await finalizeExecution(f.context, f.current(root), "a", "");
  const pending = f.aide.topics.inputStore.get(maintenance.metadata.name)!;
  assert.equal(pending.status.assess?.completedAt, undefined);
  assert.equal(pending.status.assess?.lastError, undefined);
  assert.equal(pending.status.assess?.executionId, undefined);
  assert.deepEqual((await nextInputs(f.resources, f.current(root), 8)).map(i => i.metadata.name), [maintenance.metadata.name]);
  assert.ok(f.aide.topics.inputStore.get("urgent")!.status.assess?.completedAt);
});

/** @case Deferred batches drain at a full Input quota without allocating a maintenance or synthetic Input. */
test("Ten deferred Inputs activate one bounded business batch before full-quota maintenance", async t => {
  const f = fixture(t), root = await f.aide.topics.ensure("a");
  for (let i = 0; i < 10; i++) await f.input(`batch-${i}`, [root], InputAttention.Deferred);
  f.aide.topics.inputStore.storage.configure({ kinds: { "aide.dev/Input": { maxCount: 10 } } });
  await reconcileChief(f.context, f.execution("batch"), f.current(root), (await import("../plugins/personal/topic/config.ts")).topicPolicy({ maxUnfiledInput: 1 }));
  assert.equal(f.prompts.length, 1); assert.equal(f.aide.topics.inputStore.list().length, 10);
  assert.doesNotMatch(f.prompts[0]!.prompt, /aide:triage/);
  for (let i = 0; i < 10; i++) {
    const receipt = f.aide.topics.inputStore.get(`batch-${i}`)!.status.assess!;
    assert.equal(receipt.executionId, "batch"); assert.ok(receipt.errorAt, "missing confirmation records a dated failure");
  }
});

test("Deferred deadline uses oldest creation, independently of review, and queries are bounded", async t => {
  const { readyBusinessInputs } = await import("../plugins/personal/input/scheduling.ts");
  const { topicPolicy } = await import("../plugins/personal/topic/config.ts");
  const f = fixture(t), root = await f.aide.topics.ensure("a");
  const first = await f.input("oldest", [root], InputAttention.Deferred);
  await f.input("later", [root], InputAttention.Deferred);
  const now = Date.parse(first.metadata.creationTimestamp);
  const resources = { ...f.resources, list: async () => { throw new Error("Selection must not list a whole tree"); },
    page: <S, T>(type: import("@compforge/aide-plugin").ResourceType, options: import("@compforge/aide-plugin").ResourcePageOptions) => { assert.ok(options.limit <= 10); return f.resources.page<S, T>(type, options); } };
  assert.equal((await readyBusinessInputs(resources, f.current(root), topicPolicy(), now + 599999)).inputs.length, 0);
  const ready = await readyBusinessInputs(resources, f.current(root), topicPolicy(), now + 600000);
  assert.equal(ready.reason, "age"); assert.equal(ready.inputs[0]!.metadata.name, "oldest");
});

for (const outcome of ["accepted", "rejected", "uncertain"] as const) test(`Deferred followUp batch ${outcome} keeps individual atomic receipts`, async t => {
  const { submitPending } = await import("../plugins/personal/loop.ts");
  const f = fixture(t), root = await f.aide.topics.ensure("a");
  await running(f, root);
  for (let i = 0; i < 10; i++) await f.input(`batch-${i}`, [root], InputAttention.Deferred);
  const deliveries: any[] = [];
  mockRunning(f, async args => {
    deliveries.push(args);
    assert.ok(f.aide.topics.inputStore.list().every(i => i.status.assess?.executionId === "a"));
    if (outcome === "uncertain") throw new Error("delivery result unknown");
    return { state: "success", value: { outcome, reason: outcome === "rejected" ? "unsupported" : undefined } };
  });
  const execution = { verbs: { action: async (_: string, args: unknown) => ({ state: "success", value: await f.aide.personal.submitTopic(intake(root), args) }) } } as unknown as ReconcileContext;
  const submitted = submitPending(f.context, execution, f.current(root));
  if (outcome === "uncertain") await assert.rejects(submitted, /result unknown/); else await submitted;
  assert.equal(deliveries.length, 1); assert.equal(deliveries[0].operation, "followUp");
  const inputs = f.aide.topics.inputStore.list();
  for (const input of inputs) {
    assert.equal(input.spec.attention, InputAttention.Deferred);
    assert.equal(input.status.assess!.executionId, outcome === "rejected" ? undefined : "a");
    if (outcome === "uncertain") assert.ok(input.status.assess!.errorAt);
    if (outcome === "accepted") assert.equal(input.status.assess!.deliveryId, deliveries[0].messageId);
  }
});


test("A running Chief admits one outstanding deferred batch and resumes after its receipts", async t => {
  const { submitPending } = await import("../plugins/personal/loop.ts");
  const f = fixture(t), root = await f.aide.topics.ensure("a"); await running(f, root);
  for (let i = 0; i < 20; i++) await f.input(`bounded-${String(i).padStart(2, "0")}`, [root], InputAttention.Deferred);
  const deliveries: any[] = [];
  mockRunning(f, async args => { deliveries.push(args); return { state: "success", value: { outcome: "accepted" } }; });
  const execution = { verbs: { action: async (_: string, args: unknown) => ({ state: "success", value: await f.aide.personal.submitTopic(intake(root), args) }) } } as unknown as ReconcileContext;
  await submitPending(f.context, execution, f.current(root));
  await submitPending(f.context, execution, f.current(root));
  assert.equal(deliveries.length, 1);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.status.assess?.executionId).length, 10);
  await f.input("urgent-during-batch", [root], InputAttention.Immediate);
  await submitPending(f.context, execution, f.current(root));
  assert.equal(deliveries.length, 2); assert.equal(deliveries[1].operation, "steer");
  for (let i = 0; i < 10; i++) await assessInput(f.resources, f.current(root), "a", {
    inputId: `bounded-${String(i).padStart(2, "0")}`, summary: "Handled",
  });
  await submitPending(f.context, execution, f.current(root));
  assert.equal(deliveries.length, 3); assert.equal(deliveries[2].operation, "followUp");
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.status.assess?.executionId && !i.status.assess.completedAt).length, 11);
});
