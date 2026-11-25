import { collectResources } from "./fixtures/resource-gc.ts";
import { summaryText } from "../plugins/personal/note/summary.ts";
import { patchSummary } from "./summary-fixture.ts";
import { TASK_TYPE } from "../plugins/personal/task/model.ts";
import { notes } from "../plugins/personal/note/query.ts";
import { contentVersion } from "../plugins/personal/context-write.ts";
import { seedNotes } from "./fixtures/notes.ts";
import { topicView } from "../src/channel/view.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { deliverInput } from "./input-state-fixture.ts";
import { deliver } from "../plugins/personal/route/delivery.ts";
import { admit } from "./input-state-fixture.ts";
import { cancelAssignments, resourceRef } from "../plugins/personal/input/state.ts";
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

test("Concurrent Chief assessments record a single receipt without assigning Work", async t => {
  const { aide, resources, context } = setup(t);
  const a = await aide.topics.ensure("a");
  const input = await aide.topics.submit("fact", { origin: "source", originId: "fixture", text: "shared evidence" });
  await deliver(context, input, [a.metadata], "One current Topic");
  await resources.patchStatus(a, { execution: { id: "a", startedAt: new Date().toISOString() } });
  await admit(resources, "fact", "a");
  await Promise.all([1, 2].map(() => deliverInput(resources, a, "a", "fact")));
  const result = aide.topics.inputStore.get("fact")!;
  assert.ok(result.status.assess!.completedAt);
  assert.equal(result.status.assess!.result, undefined);
  assert.deepEqual(Object.keys(result.status.handle ?? {}), []);
  assert.deepEqual(aide.topics.pending(a.metadata.uid), []);
  assert.equal("pendingInputIds" in aide.topics.resource("a")!.status, false);
  await deliverInput(resources, a, "a", "fact");
  assert.deepEqual(aide.topics.inputStore.get("fact"), result);
});

test("Failed assessment preserves the separate Work receipt and Topic state", async t => {
  const { aide, resources, context } = setup(t);
  const c = await aide.topics.ensure("me");
  const w = await aide.work("me").create(task), foreign = await aide.work("other").create(task);
  const input = await aide.topics.submit("fact", { origin: "channel", originId: "web", text: "please check" });
  await deliver(context, input, [c.metadata], "topic");
  await resources.patchStatus(aide.topics.resource("me")!, { execution: { id: "live", startedAt: new Date().toISOString() } });
  await admit(resources, "fact", "live");
  await assert.rejects(aide.work("me").appendInput(foreign.id, { id: "fact" }), /Unknown work/);
  await aide.work("me").appendInput(w.id, { id: "fact" });
  const before = aide.topics.inputStore.get("fact")!;
  const handlesBefore = aide.topics.inputStore.query("handlePending", w.uid!);
  const topicBefore = aide.topics.resource("me")!.status;
  const failing = { ...resources, commit: (writes: Parameters<typeof resources.commit>[0]) => resources.commit([...writes,
    { operation: "create", type: { ...INPUT_TYPE, kind: "Unregistered" }, name: "failure", spec: {}, status: {} }]) };
  await assert.rejects(deliverInput(failing, c, "live", "fact"), /Unknown resource/);
  assert.deepEqual(aide.topics.inputStore.get("fact"), before);
  assert.deepEqual(aide.topics.resource("me")!.status, topicBefore);
  assert.deepEqual(aide.topics.inputStore.query("handlePending", w.uid!), handlesBefore);
});

test("Input protects every unfinished stage; deleting its Work ends handling and permits quota eviction", async t => {
  const { aide, resources, context } = setup(t);
  const c = await aide.topics.ensure("me");
  const w = await aide.work("me").create(task);
  const store = aide.topics.inputStore;
  const initialTask = (await resources.list(TASK_TYPE))[0]!;
  await cancelAssignments(resources, resourceRef(initialTask));
  store.storage.configure(ResourceStorageConfigSchema.parse({ kinds: { "aide.dev/Input": { maxCount: 1 } } }));
  await collectResources(store.storage);
  const input = await aide.topics.submit("one", { origin: "source", originId: "fixture", text: "fact" });
  await deliver(context, input, [c.metadata], "topic");
  const second = () => aide.topics.submit("two", { origin: "source", originId: "fixture", text: "another" });
  await assert.rejects(second(), /capacity/);
  await resources.patchStatus(aide.topics.resource("me")!, { execution: { id: "live", startedAt: new Date().toISOString() } });
  await admit(resources, "one", "live");
  await aide.work("me").appendInput(w.id, { id: "one" });
  await deliverInput(resources, c, "live", "one");
  await assert.rejects(second(), /capacity/);
  const target = (await resources.list(TASK_TYPE))[0]!;
  await resources.delete(target, target.metadata.name);
  await cancelAssignments(resources, resourceRef(target));
  assert.equal(store.get("one")!.status.handle![w.uid!]!.result!.disposition, "cancelled");
  await collectResources(store.storage);
  await assert.rejects(second(), /capacity/);
  await resources.patchStatus(aide.topics.resource("me")!, { execution: null });
  await collectResources(store.storage);
  await second();
  assert.equal(store.get("one"), undefined);
  assert.deepEqual(store.query("topic", c.metadata.uid), []);
  assert.ok(store.receipt("one"));
});

test("Topic Notes are bounded independently of long-lived summary and reject stale writes", async t => {
  const { upsertTopicNote } = await import("../plugins/personal/topic/state.ts");
  const { aide, resources } = setup(t);
  await aide.topics.ensure("me");
  await patchSummary(resources, aide.topics.resource("me")!, { execution: { id: "review", startedAt: new Date().toISOString() }, summary: "Durable distinction" });
  const stale = aide.topics.resource("me")!;
  for (let n = 0; n < 55; n++) {
    const c = aide.topics.resource("me")!;
    await upsertTopicNote(resources, c, "review", { nature: "semantic", version: c.metadata.resourceVersion, text: `Review ${n}: ${"e".repeat(2000)}` }, `review-${n}`);
  }
  const current = aide.topics.resource("me")!;
  assert.equal(summaryText(aide.topics.resources, current), "Durable distinction");
  assert.ok(notes(aide.topics.resources, current.metadata.uid, "subject").length <= 40);
  assert.ok(notes(aide.topics.resources, current.metadata.uid, "subject").reduce((sum, entry) => sum + entry.text.length, 0) <= 16000);
  assert.equal(contentVersion(stale), contentVersion(current), "Independent notes do not change summary version");
  await assert.rejects(upsertTopicNote(resources, current, "wrong-execution", { summaryOf: resourceRef(current), version: contentVersion(current), text: "stale" }, "summary", 4000, "aide:summary"), /no longer active/);
  await assert.rejects(upsertTopicNote(resources, current, "review", { summaryOf: resourceRef(current), version: contentVersion(current), text: "x".repeat(16001) }, "summary", 4000, "aide:summary"));
  assert.deepEqual(aide.topics.resource("me")!.status, current.status);
});

/** @case Repeated silent receipts do not evict important context or imply an unresolved anomaly recovered. */
test("quiet assessments retain topic understanding; explicit synthesis can update summary without recent", async t => {
  const { upsertTopicNote } = await import("../plugins/personal/topic/state.ts");
  const { aide, resources, context } = setup(t);
  const c = await aide.topics.ensure("me");
  const recent = [{ id: String(new Date().toISOString()), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), text: "User asked to investigate recurrent OOM" }];
  await patchSummary(resources, c, { execution: { id: "live", startedAt: new Date().toISOString() }, summary: "OOM unresolved; investigation delegated" });
  await seedNotes(resources, c, recent);
  const storedNotes = notes(aide.topics.resources, c.metadata.uid, "subject");
  for (let i = 0; i < 45; i++) {
    const fact = await aide.topics.submit(`quiet-${i}`, { origin: "source", originId: "fixture", text: "same-image Pod churn" });
    await deliver(context, fact, [c.metadata], "same subject");
    await admit(resources, fact.metadata.name, "live");
    await deliverInput(resources, c, "live", fact.metadata.name);
    assert.ok(aide.topics.inputStore.get(fact.metadata.name)!.status.assess!.completedAt);
  }
  const current = aide.topics.resource("me")!;
  assert.equal(summaryText(aide.topics.resources, current), "OOM unresolved; investigation delegated");
  assert.deepEqual(notes(aide.topics.resources, current.metadata.uid, "subject"), storedNotes);
  const receipt = await upsertTopicNote(resources, current, "live", { summaryOf: resourceRef(current), version: contentVersion(current), text: "OOM cause confirmed; fix pending" }, "summary", 4000, "aide:summary");
  assert.equal(receipt.version, aide.topics.resource("me")!.status.summaryRevision);
  assert.deepEqual(notes(aide.topics.resources, current.metadata.uid, "subject"), storedNotes);
  assert.equal(summaryText(aide.topics.resources, aide.topics.resource("me")!), "OOM cause confirmed; fix pending");
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
  await assert.rejects(deliverInput(racing, c, "old", "switch"), /no longer active/);
  assert.equal(aide.topics.inputStore.get("switch")!.status.assess!.completedAt, undefined);
  assert.equal(aide.topics.inputStore.get("switch")!.status.assess!.executionId, "old");
});

test("Delivery retains the admission binding without a model tool receipt", async t => {
  const { aide, resources, context } = setup(t);
  const c = await aide.topics.ensure("me");
  const input = await aide.topics.submit("recover", { origin: "channel", originId: "web", text: "check effects" });
  await deliver(context, input, [c.metadata], "explicit");
  const currentAgent = { harness: "chief", sessionId: "recovery-native" };
  await resources.patchStatus(aide.topics.resource("me")!, { agent: currentAgent, execution: { id: "new-run", startedAt: new Date().toISOString() } });
  await deliverInput(resources, c, "new-run", "recover");
  const receipt = aide.topics.inputStore.get("recover")!.status.assess!;
  assert.equal(receipt.executionId, "new-run"); assert.equal(receipt.agent, undefined);
  assert.equal(receipt.completedBy, undefined);
  await deliverInput(resources, c, "new-run", "recover");
  assert.deepEqual(aide.topics.inputStore.get("recover")!.status.assess, receipt);
});

/** @case A failed Input keeps its terminal receipt even when a later Chief can inspect its effects. */
test("Failed assessment cannot be completed by a later Chief execution", async t => {
  const { aide, resources, context } = setup(t);
  const c = await aide.topics.ensure("me");
  const input = await aide.topics.submit("failed-input", { origin: "channel", originId: "web", text: "verify prior effects" });
  await deliver(context, input, [c.metadata], "explicit");
  const admitted = aide.topics.inputStore.get(input.metadata.name)!;
  await resources.patchStatus(aide.topics.resource("me")!, { execution: { id: "old-run", startedAt: new Date().toISOString() } });
  await resources.patchStatus(admitted, { assess: { executionId: "old-run", startedAt: new Date().toISOString(), lastError: "Interrupted" } });
  const failed = aide.topics.inputStore.get(input.metadata.name)!;
  const agent = { harness: "chief", sessionId: "another-native" };
  await resources.patchStatus(aide.topics.resource("me")!, { agent, execution: { id: "new-run", startedAt: new Date().toISOString() } });
  await deliverInput(resources, c, "new-run", input.metadata.name);
  await assert.rejects(resources.patchStatus(failed, { assess: { ...failed.status.assess, completedAt: new Date().toISOString() } }), /has failed/);
  await assert.rejects(aide.work("me").create(task, input.metadata.name, "retry-failed-input"), /Failed Input cannot be assigned/);
  assert.equal((await resources.list(TASK_TYPE)).length, 0, "failed handoff rolls back Task creation");
  assert.deepEqual(aide.topics.inputStore.get(input.metadata.name)!.status.assess, failed.status.assess);
  assert.equal(topicView(aide, "me").blocks.find(b => b.inputId === input.metadata.name)!.group_id, "old-run");
});
