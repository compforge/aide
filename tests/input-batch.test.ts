import assert from "node:assert/strict";
import { test } from "node:test";
import { secretaryFixture } from "./secretary-fixture.ts";
import { prepareInputs, expandInputs } from "../plugins/personal/input/batch.ts";
import { INPUT_TYPE, InputAttention } from "../plugins/personal/input/model.ts";
import { preparedInputs } from "../plugins/personal/input/scheduling.ts";
import { reconcileChief } from "../plugins/personal/topic/reconcile.ts";
import { assessInput } from "../plugins/personal/topic/assess.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { repairBatchMember, assignInput } from "../plugins/personal/input/assignment.ts";

for (const attention of [InputAttention.Deferred, InputAttention.Normal, InputAttention.Immediate])
test(`${attention} count promotion atomically delegates compatible originals and preserves authority`, async t => {
  const f = await secretaryFixture(t);
  await f.input("a", attention); await f.input("b", attention);
  await prepareInputs(f.context, f.root(), f.policy);
  const ready = await preparedInputs(f.resources, f.root());
  assert.equal(ready.length, 1); const batch = ready[0]!;
  assert.deepEqual(batch.spec.batch!.members.map(m => m.name), ["a", "b"]);
  assert.equal(batch.spec.attention, attention === InputAttention.Immediate ? attention : InputAttention.Normal);
  assert.equal(batch.spec.origin, "source");
  assert.equal(f.aide.topics.inputStore.get("a")!.status.batch!.uid, batch.metadata.uid);
  assert.equal((await f.resources.page(INPUT_TYPE, { matchIndex: { name: "secretaryPending", value: f.root().metadata.uid }, limit: 10 })).items.length, 0);
  await prepareInputs(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.batch).length, 1);
  await reconcileChief(f.context, f.execution(), f.root(), f.policy);
  for (const id of ["a", "b", batch.metadata.name]) assert.ok(f.aide.topics.inputStore.get(id)!.status.assess?.completedAt);
  assert.equal(f.calls(), 1);
});

test("Single Deferred ages into Normal without resetting oldest arrival or waiting for an idle Chief", async t => {
  const f = await secretaryFixture(t); const first = await f.input("old");
  await f.resources.patchStatus(f.root(), { execution: { id: "busy", startedAt: new Date().toISOString() } });
  await prepareInputs(f.context, f.root(), f.policy, Date.parse(first.metadata.creationTimestamp) + 600_001);
  const batch = f.aide.topics.inputStore.list().find(i => i.spec.batch)!;
  assert.equal(batch.spec.batch!.oldestAt, first.metadata.creationTimestamp);
  assert.equal(batch.spec.attention, InputAttention.Normal); assert.equal(f.calls(), 0);
});

test("Concurrent preparation cannot put a member into two batches", async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b");
  await Promise.allSettled([prepareInputs(f.context, f.root(), f.policy), prepareInputs(f.context, f.root(), f.policy)]);
  const batches = f.aide.topics.inputStore.list().filter(i => i.spec.batch);
  assert.equal(batches.length, 1);
  for (const id of ["a", "b"]) assert.equal(f.aide.topics.inputStore.get(id)!.status.batch!.uid, batches[0]!.metadata.uid);
});

test("Incompatible origin IDs do not mix; overdue internal maintenance moves ahead without becoming Immediate", async t => {
  const f = await secretaryFixture(t);
  await f.input("a", InputAttention.Deferred, "source", "one"); await f.input("b", InputAttention.Deferred, "source", "two");
  await prepareInputs(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.batch).length, 0);
  const review = await f.input("review", InputAttention.Normal, "aide:review");
  await prepareInputs(f.context, f.root(), f.policy, Date.parse(review.metadata.creationTimestamp) + 600_001);
  const prepared = f.aide.topics.inputStore.get("review")!;
  assert.ok(prepared.status.promotedAt); assert.equal(prepared.spec.attention, InputAttention.Normal);
});

test("Partial success survives failed batch execution and is never automatically replayed", async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b"); await prepareInputs(f.context, f.root(), f.policy);
  await reconcileChief(f.context, f.execution("partial", async () => { await assessInput(f.resources, f.root(), "partial", { inputId: "a", summary: "done" }); }), f.root(), f.policy);
  assert.ok(f.aide.topics.inputStore.get("a")!.status.assess?.completedAt);
  assert.ok(f.aide.topics.inputStore.get("b")!.status.assess?.lastError);
  const batch = f.aide.topics.inputStore.list().find(i => i.spec.batch)!;
  assert.ok(batch.status.assess?.lastError); assert.equal(batch.status.assess?.completedAt, undefined);
  await prepareInputs(f.context, f.root(), f.policy);
  assert.equal((await preparedInputs(f.resources, f.root())).length, 0);
});

test("Batch material loss is explicit and releases surviving unclaimed members", async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b"); await prepareInputs(f.context, f.root(), f.policy);
  const batch = f.aide.topics.inputStore.list().find(i => i.spec.batch)!;
  const member = f.aide.topics.inputStore.get("a")!;
  await f.resources.delete(INPUT_TYPE, member.metadata.name, "v1", { uid: member.metadata.uid, resourceVersion: member.metadata.resourceVersion });
  await assert.rejects(expandInputs(f.resources, [batch]), /unavailable/);
  await prepareInputs(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.get(batch.metadata.name)!.status.assess?.result?.disposition, "cancelled");
  assert.equal(f.aide.topics.inputStore.get("b")!.status.batch, undefined);
});

// @case Loss of a scheduling envelope cannot strand original unclaimed material.
test("Deleted batch envelope releases members and permits a new unique preparation", async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b");
  await prepareInputs(f.context, f.root(), f.policy);
  const old = f.aide.topics.inputStore.list().find(i => i.spec.batch)!;
  await f.resources.delete(INPUT_TYPE, old.metadata.name, "v1", { uid: old.metadata.uid, resourceVersion: old.metadata.resourceVersion });
  for (const id of ["a", "b"]) {
    await repairBatchMember(f.context, f.aide.topics.inputStore.get(id)!);
    await assignInput(f.context, f.aide.topics.inputStore.get(id)!);
  }
  await prepareInputs(f.context, f.root(), f.policy);
  const ready = await preparedInputs(f.resources, f.root());
  assert.equal(ready.length, 1); assert.notEqual(ready[0]!.metadata.uid, old.metadata.uid);
  assert.deepEqual(ready[0]!.spec.batch!.members.map(m => m.name), ["a", "b"]);
});

test("Batch validator refuses privacy or origin changes and rolls back delegation", async t => {
  const f = await secretaryFixture(t); const a = await f.input("a"), b = await f.input("b");
  const at = new Date().toISOString();
  await assert.rejects(f.resources.create(INPUT_TYPE, { name: "forged", spec: { ...a.spec, attention: InputAttention.Normal,
    visibility: "any", batch: { members: [resourceRef(a), resourceRef(b)], oldestAt: a.metadata.creationTimestamp } },
    status: { topic: resourceRef(f.root()), assess: { topic: resourceRef(f.root()) }, route: { completedAt: at } },
  }), /changes origin or attention/);
  assert.equal(f.aide.topics.inputStore.get("a")!.status.batch, undefined);
  assert.equal(f.aide.topics.inputStore.get("forged"), undefined);
});

// @case Source-to-Channel identity correction preserves admitted receipts; unclaimed batches regroup.
for (const claimed of [false, true]) test(`Channel promotion ${claimed ? "during" : "before"} batch execution preserves original evidence`, async t => {
  const f = await secretaryFixture(t);
  const a = await f.input("a", InputAttention.Deferred, "source", "fixture", { inputKey: "message:a" });
  const b = await f.input("b");
  await prepareInputs(f.context, f.root(), f.policy);
  const batch = f.aide.topics.inputStore.list().find(i => i.spec.batch)!;
  const promote = async () => {
    const current = f.aide.topics.inputStore.get(a.metadata.name)!;
    await f.resources.replace(current, { ...current.spec, origin: "channel", attention: InputAttention.Immediate }, current.status);
  };
  if (claimed) {
    await reconcileChief(f.context, f.execution("promoted", async () => {
      await promote();
      for (const input of [a, b]) await assessInput(f.resources, f.root(), "promoted", { inputId: input.metadata.name, summary: "handled once" });
    }), f.root(), f.policy);
    assert.ok(f.aide.topics.inputStore.get(batch.metadata.name)!.status.assess?.completedAt);
    assert.ok(f.aide.topics.inputStore.get(a.metadata.name)!.status.assess?.completedAt);
  } else {
    await promote(); await prepareInputs(f.context, f.root(), f.policy);
    assert.equal(f.aide.topics.inputStore.get(batch.metadata.name)!.status.assess?.result?.disposition, "cancelled");
    for (const input of [a, b]) await assignInput(f.context, f.aide.topics.inputStore.get(input.metadata.name)!);
    assert.equal((await preparedInputs(f.resources, f.root()))[0]!.metadata.uid, a.metadata.uid);
    assert.equal(f.aide.topics.inputStore.get(b.metadata.name)!.status.assess?.executionId, undefined);
  }
});

test("Capacity fallback promotion retains backpressure while a prepared batch is executing", async t => {
  const f = await secretaryFixture(t); const a = await f.input("a"), b = await f.input("b");
  for (const input of [a, b]) await f.resources.patchStatus(input, { promotedAt: new Date().toISOString() });
  await f.resources.patchStatus(f.root(), { execution: { id: "busy", startedAt: new Date().toISOString() } });
  const claimed = f.aide.topics.inputStore.get("a")!;
  await f.resources.patchStatus(claimed, { assess: { ...claimed.status.assess, executionId: "busy", startedAt: new Date().toISOString() } });
  assert.equal((await preparedInputs(f.resources, f.root())).length, 0);
  await f.input("urgent", InputAttention.Immediate);
  assert.equal((await preparedInputs(f.resources, f.root()))[0]!.metadata.name, "urgent");
  await assessInput(f.resources, f.root(), "busy", { inputId: "a", summary: "finished" });
  assert.ok((await preparedInputs(f.resources, f.root())).some(i => i.metadata.name === "b"));
});
