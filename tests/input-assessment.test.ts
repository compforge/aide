import { topicView } from "../src/channel/view.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { assessInput } from "../plugins/personal/topic/assess.ts";
import { deliver } from "../plugins/personal/route/delivery.ts";
import { admit } from "./input-state-fixture.ts";
import { cancelAssignments, resourceRef } from "../plugins/personal/input/state.ts";
import { InputDefinition } from "../plugins/personal/input/definition.ts";
import { INPUT_TYPE, InputAttention } from "../plugins/personal/input/model.ts";
import { ResourceStorageConfigSchema } from "../src/host/resource/storage.ts";
function setup(t: { after(fn: () => Promise<void>): void }) {
  const home = mkdtempSync(join(tmpdir(), "aide-assess-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected execution"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  return { aide, resources, context: { resources, logger: { info() {} } } };
}
const task = { kind: "task" as const, title: "Check", instruction: "Verify evidence", trigger: null };

test("Concurrent Chief assessments complete once and atomically establish only the winning Work handoff", async t => {
  const { aide, resources, context } = setup(t);
  const a = await aide.topics.ensure("a"), b = await aide.topics.ensure("b");
  const wa = await aide.work("a").create(task), wb = await aide.work("a").create(task);
  const input = await aide.topics.submit("fact", { origin: "source", originId: "fixture", text: "shared evidence" });
  await deliver(context, input, [a.metadata], "One current Topic");
  for (const c of [a, b]) {
    await resources.patchStatus(aide.topics.resource(c.spec.id)!, { execution: { id: c.spec.id, startedAt: new Date().toISOString() } });
  }
  await Promise.all([[a, wa], [a, wb]].map(async ([owner, work]) => {
    const c = owner as typeof a, w = work as typeof wa;
    await assessInput(resources, c, c.spec.id, { inputId: "fact", summary: `Assigned to ${w.id}`, workRequests: [{ workUid: w.uid!, request: { action: "context" } }] });
  }));
  const result = aide.topics.inputStore.get("fact")!;
  assert.ok(result.status.assess!.completedAt);
  assert.equal(Object.keys(result.status.handle!).length, 1);
  const winner = result.status.assess!.result!.summary.endsWith(wa.id) ? wa : wb;
  assert.deepEqual(Object.keys(result.status.handle!), [winner.uid]);
  assert.equal(InputDefinition.retention!.releasedAt(result), undefined);
  assert.deepEqual(aide.topics.pending(a.metadata.uid), []);
  assert.equal("pendingInputIds" in aide.topics.resource("a")!.status, false);
  await assessInput(resources, a, "a", { inputId: "fact", summary: "repeat" });
  assert.deepEqual(aide.topics.inputStore.get("fact"), result);
});

test("Failed handoff rolls back assessment, Work assignments and summary; foreign Work cannot be assigned", async t => {
  const { aide, resources, context } = setup(t);
  const c = await aide.topics.ensure("me");
  const w = await aide.work("me").create(task), foreign = await aide.work("other").create(task);
  const input = await aide.topics.submit("fact", { origin: "channel", originId: "web", text: "please check" });
  await deliver(context, input, [c.metadata], "topic");
  await resources.patchStatus(aide.topics.resource("me")!, { execution: { id: "live", startedAt: new Date().toISOString() } });
  await admit(resources, "fact", "live");
  const before = aide.topics.inputStore.get("fact")!;
  const handlesBefore = aide.topics.inputStore.query("handlePending", w.uid!);
  const topicBefore = aide.topics.resource("me")!.status;
  await assert.rejects(assessInput(resources, c, "live", { inputId: "fact", summary: "bad", workRequests: [{ workUid: foreign.uid!, request: {} }] }), /Work unavailable/);
  const failing = { ...resources, commit: (writes: Parameters<typeof resources.commit>[0]) => resources.commit([...writes,
    { operation: "create", type: { ...INPUT_TYPE, kind: "Unregistered" }, name: "failure", spec: {}, status: {} }]) };
  await assert.rejects(assessInput(failing, c, "live", { inputId: "fact", summary: "handoff", workRequests: [{ workUid: w.uid!, request: {} }] }), /Unknown resource/);
  assert.deepEqual(aide.topics.inputStore.get("fact"), before);
  assert.deepEqual(aide.topics.resource("me")!.status, topicBefore);
  assert.deepEqual(aide.topics.inputStore.query("handlePending", w.uid!), handlesBefore);
});

test("Input protects every unfinished stage; deleting its Work ends handling and permits quota eviction", async t => {
  const { aide, resources, context } = setup(t);
  const c = await aide.topics.ensure("me");
  const w = await aide.work("me").create(task);
  const store = aide.topics.inputStore;
  const initialTask = (await resources.list({ ...INPUT_TYPE, kind: "Task" }))[0]!;
  await cancelAssignments(resources, resourceRef(initialTask));
  store.storage.configure(ResourceStorageConfigSchema.parse({ kinds: { "aide.dev/Input": { maxCount: 1 } } }));
  const input = await aide.topics.submit("one", { origin: "source", originId: "fixture", text: "fact" });
  await deliver(context, input, [c.metadata], "topic");
  const second = () => aide.topics.submit("two", { origin: "source", originId: "fixture", text: "another" });
  await assert.rejects(second(), /capacity/);
  await resources.patchStatus(aide.topics.resource("me")!, { execution: { id: "live", startedAt: new Date().toISOString() } });
  await admit(resources, "one", "live");
  await assessInput(resources, c, "live", { inputId: "one", summary: "Delegated", workRequests: [{ workUid: w.uid!, request: {} }] });
  await assert.rejects(second(), /capacity/);
  const target = (await resources.list({ apiVersion: INPUT_TYPE.apiVersion, kind: "Task" }))[0]!;
  await resources.delete(target, target.metadata.name);
  await cancelAssignments(resources, resourceRef(target));
  assert.equal(store.get("one")!.status.handle![w.uid!]!.result!.disposition, "cancelled");
  await second();
  assert.equal(store.get("one"), undefined);
  assert.deepEqual(store.query("topic", c.metadata.uid), []);
  assert.ok(store.receipt("one"));
});

test("Topic Notes are bounded independently of long-lived summary and reject stale writes", async t => {
  const { summarizeTopic, upsertTopicNote } = await import("../plugins/personal/topic/state.ts");
  const { aide, resources } = setup(t);
  await aide.topics.ensure("me");
  await resources.patchStatus(aide.topics.resource("me")!, { execution: { id: "review", startedAt: new Date().toISOString() }, summary: "Durable distinction" });
  const stale = aide.topics.resource("me")!;
  for (let n = 0; n < 55; n++) {
    const c = aide.topics.resource("me")!;
    await upsertTopicNote(resources, c, "review", { version: c.metadata.resourceVersion, text: `Review ${n}: ${"e".repeat(2000)}` }, `review-${n}`);
  }
  const current = aide.topics.resource("me")!;
  assert.equal(current.status.summary, "Durable distinction");
  assert.ok(current.status.recent.length <= 40);
  assert.ok(current.status.recent.reduce((sum, entry) => sum + entry.text.length, 0) <= 16000);
  await assert.rejects(summarizeTopic(resources, stale, "review", { version: stale.metadata.resourceVersion, summary: "stale" }, 4000), /changed/);
  await assert.rejects(summarizeTopic(resources, current, "wrong-execution", { version: current.metadata.resourceVersion, summary: "stale" }, 4000), /no longer active/);
  await assert.rejects(summarizeTopic(resources, current, "review", { version: current.metadata.resourceVersion, summary: "x".repeat(4001) }, 4000), /exceeds/);
  assert.deepEqual(aide.topics.resource("me")!.status, current.status);
});

/** @case Repeated silent receipts do not evict important context or imply an unresolved anomaly recovered. */
test("quiet assessments retain topic understanding; explicit synthesis can update summary without recent", async t => {
  const { summarizeTopic } = await import("../plugins/personal/topic/state.ts");
  const { aide, resources, context } = setup(t);
  const c = await aide.topics.ensure("me");
  const recent = [{ id: String(new Date().toISOString()), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), text: "User asked to investigate recurrent OOM" }];
  await resources.patchStatus(c, { execution: { id: "live", startedAt: new Date().toISOString() }, summary: "OOM unresolved; investigation delegated", recent });
  for (let i = 0; i < 45; i++) {
    const fact = await aide.topics.submit(`quiet-${i}`, { origin: "source", originId: "fixture", text: "same-image Pod churn" });
    await deliver(context, fact, [c.metadata], "same subject");
    await admit(resources, fact.metadata.name, "live");
    await assessInput(resources, c, "live", { inputId: fact.metadata.name, summary: "No new action" });
    assert.ok(aide.topics.inputStore.get(fact.metadata.name)!.status.assess!.completedAt);
  }
  const current = aide.topics.resource("me")!;
  assert.equal(current.status.summary, "OOM unresolved; investigation delegated");
  assert.deepEqual(current.status.recent, recent);
  const receipt = await summarizeTopic(resources, current, "live", { version: current.metadata.resourceVersion, summary: "OOM cause confirmed; fix pending" }, 4000);
  assert.deepEqual(Object.keys(receipt), ["version", "understandingVersion"], "Do not echo all context back into model history");
  assert.deepEqual(aide.topics.resource("me")!.status.recent, recent);
  assert.equal(aide.topics.resource("me")!.status.summary, "OOM cause confirmed; fix pending");
});

for (const attention of [InputAttention.Normal, InputAttention.Deferred])
test(`${attention} assessment cannot complete across an execution switch during its commit`, async t => {
  const { aide, resources, context } = setup(t);
  const c = await aide.topics.ensure("me");
  const fact = await aide.topics.submit("switch", { origin: "source", originId: "fixture", attention, text: "observation" });
  await deliver(context, fact, [c.metadata], "topic");
  await resources.patchStatus(aide.topics.resource("me")!, { execution: { id: "old", startedAt: new Date().toISOString() } });
  if (attention !== InputAttention.Deferred) await admit(resources, "switch", "old");
  let switched = false;
  const racing = { ...resources, commit: async (writes: Parameters<typeof resources.commit>[0]) => {
    if (!switched) { switched = true; await resources.patchStatus(aide.topics.resource("me")!, { execution: { id: "new", startedAt: new Date().toISOString() } }); }
    return resources.commit(writes);
  } };
  await assert.rejects(assessInput(racing, c, "old", { inputId: "switch", summary: "quiet" }), /no longer active/);
  assert.equal(aide.topics.inputStore.get("switch")!.status.assess!.completedAt, undefined);
  if (attention === InputAttention.Deferred) assert.equal(aide.topics.inputStore.get("switch")!.status.assess!.executionId, undefined);
});

test("Assessment records completion evidence without claiming Chief execution ownership", async t => {
  const { aide, resources, context } = setup(t);
  const c = await aide.topics.ensure("me");
  const input = await aide.topics.submit("recover", { origin: "channel", originId: "web", text: "check effects" });
  await deliver(context, input, [c.metadata], "explicit");
  const currentAgent = { harness: "chief", sessionId: "recovery-native" };
  await resources.patchStatus(aide.topics.resource("me")!, { agent: currentAgent, execution: { id: "new-run", startedAt: new Date().toISOString() } });
  await assessInput(resources, c, "new-run", { inputId: "recover", summary: "Verified effects" }, "ack-native-id");
  const receipt = aide.topics.inputStore.get("recover")!.status.assess!;
  assert.equal(receipt.executionId, undefined); assert.equal(receipt.agent, undefined);
  assert.deepEqual(receipt.completedBy, { agent: currentAgent, executionId: "new-run", toolCallId: "ack-native-id" });
  await assessInput(resources, c, "new-run", { inputId: "recover", summary: "repeat" }, "different-call");
  assert.deepEqual(aide.topics.inputStore.get("recover")!.status.assess, receipt);
});

/** @case Recovery completion changes presentation grouping while preserving the original admission fence. */
test("Recovered assessment groups the Input with the completing Chief execution", async t => {
  const { aide, resources, context } = setup(t);
  const c = await aide.topics.ensure("me");
  const input = await aide.topics.submit("recover-view", { origin: "channel", originId: "web", text: "verify prior effects" });
  await deliver(context, input, [c.metadata], "explicit");
  const admitted = aide.topics.inputStore.get(input.metadata.name)!;
  await resources.patchStatus(admitted, { assess: { executionId: "old-run", startedAt: new Date().toISOString(), lastError: "Interrupted" } });
  assert.equal(aide.topics.input(input.metadata.name, "me")!.consumption.executionId, "old-run");
  assert.equal(topicView(aide, "me").blocks.find(b => b.inputId === input.metadata.name)!.group_id, "old-run");
  const agent = { harness: "chief", sessionId: "recovery-native" };
  await resources.patchStatus(aide.topics.resource("me")!, { agent, execution: { id: "new-run", startedAt: new Date().toISOString() } });
  await assessInput(resources, c, "new-run", { inputId: input.metadata.name, summary: "Verified prior effects" }, "recovery-ack");
  const receipt = aide.topics.inputStore.get(input.metadata.name)!.status.assess!;
  assert.equal(receipt.executionId, "old-run", "completion must preserve the admission fence");
  assert.equal(receipt.completedBy!.executionId, "new-run");
  assert.equal(aide.topics.input(input.metadata.name, "me")!.consumption.executionId, "new-run");
  assert.equal(topicView(aide, "me").blocks.find(b => b.inputId === input.metadata.name)!.group_id, "new-run");
});
