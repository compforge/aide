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
  const execution = (id: string, onPrompt?: () => Promise<void>) => ({ executionId: id, withContext() { return this; }, verbs: { async harness(args: { operation?: string; prompt?: string }) {
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
  await running(f, a); await f.input("shared", [a]);
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
  assert.deepEqual(f.aide.topics.inputStore.get("deferred")!.status.assess, {});
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
  const watch = assignmentWatch("assess", "Topic", f.resources);
  const claimed = await f.resources.patchStatus(fact, { assess: { executionId: "a", startedAt: new Date().toISOString() } });
  const rejected = await f.resources.patch(claimed, { type: "json", value: [{ op: "replace", path: "/status/assess", value: {} }] });
  const completed = await f.resources.patchStatus(rejected, { assess: { completedAt: new Date().toISOString() } });
  assert.deepEqual(await watch.handler.update!({ oldObject: fact, newObject: claimed } as any), []);
  assert.deepEqual(await watch.handler.update!({ oldObject: claimed, newObject: rejected } as any), []);
  assert.deepEqual(await watch.handler.update!({ oldObject: rejected, newObject: completed } as any), [{ name: a.metadata.name, namespace: a.metadata.namespace }]);
  await assert.rejects(f.resources.patch(completed, { type: "json", value: [{ op: "replace", path: "/status/assess", value: {} }] }), /already completed/);
});
