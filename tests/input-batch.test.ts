import { chiefPreviews } from "../plugins/personal/chief/inputs.ts";
import { readChiefInput } from "../plugins/personal/execution/agent/read-input.ts";
import { topicTools } from "../plugins/personal/chief/agent/topic-tools.ts";
import { inputDetail } from "../src/api/inputs.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { secretaryFixture } from "./secretary-fixture.ts";
import { cancelBatch } from "../plugins/personal/batch/reconcile.ts";
import { prepareInputs } from "../plugins/personal/secretary/batching.ts";
import { prepareSecretary, reconcileSecretary } from "../plugins/personal/secretary/reconcile.ts";
import { batchById, batchMembers } from "../plugins/personal/batch/members.ts";
import { recordDelivery, recoverInputDeliveries } from "../plugins/personal/chief/delivery.ts";
import { BATCH_TYPE, type BatchSpec, type BatchStatus } from "../plugins/personal/batch/model.ts";
import { preparedIntake } from "../plugins/personal/secretary/intake.ts";
import { commitStatus } from "../plugins/personal/status.ts";
import { INPUT_TYPE, InputAttention } from "../plugins/personal/input/model.ts";
import { reconcileChief } from "../plugins/personal/chief/reconcile.ts";
import { deliverInput } from "./input-state-fixture.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { runInput } from "../plugins/personal/execution/loop.ts";

// @case Sealing separates subsequent arrivals and Chief never writes member assessment receipts.
test("Deferred Batch seals its members and Chief completes only the Batch", async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b");
  await prepareInputs(f.context, f.root(), f.policy);
  const ready = await preparedIntake(f.resources, f.root()), batch = ready.batch!;
  assert.equal("inputRefs" in batch.spec, false);
  assert.ok(ready.inputs.every(i => i.status.batchAt && i.spec.attention === InputAttention.Deferred));
  await f.input("later"); await prepareInputs(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.get("later")!.status.batchId, undefined);
  assert.deepEqual((await batchMembers(f.resources, batch)).map(i => i.metadata.name), ["a", "b"]);
  await reconcileChief(f.context, f.execution("one", async () => {
    assert.ok(f.aide.topics.inputStore.list().every(i => !i.status.assess?.executionId));
    const [item] = chiefPreviews(ready.inputs, 4000);
    assert.equal(item!.inputId, batch.metadata.uid);
    const store = f.aide.personal.store, id = item!.inputId;
    const list = topicTools(store, f.root).find(tool => tool.name === "list_inputs")!;
    const listed = await list.execute("list", {}, undefined, undefined, {} as never);
    const page = JSON.parse((listed.content[0] as { text: string }).text);
    assert.deepEqual(page.items.map((i: { id: string }) => i.id).sort(), [id, "later"].sort());
    const read = readChiefInput(store, f.root(), id, 0, 8000);
    assert.ok("text" in read);
    assert.match(read.text, /evidence a/); assert.match(read.text, /evidence b/);
    assert.doesNotMatch(read.text, /Scheduling batch/);
    await recordDelivery(f.resources, f.root(), "one", "one");
    await recordDelivery(f.resources, f.root(), "one", "one");
    const completed = readChiefInput(store, f.root(), id, 0, 8000);
    assert.ok("status" in completed);
    assert.ok(completed.status?.completedAt);
    assert.equal(f.aide.topics.inputStore.get("a")!.status.assess?.completedAt, undefined);
  }), f.root(), f.policy);
  assert.equal((await batchById(f.resources, batch.metadata.uid))!.status.phase, "completed");
  assert.equal(f.root().status.chiefWorkload?.completed, 1, "one Batch, including duplicate receipt, counts once");
  const detail = inputDetail(f.aide, "a")!;
  assert.ok(detail.batch!.status.assess?.completedAt);
  assert.equal(detail.input.status.assess?.completedAt, undefined);
  assert.ok(detail.timeline.some(e => e.status === "completed" && e.title === "Batch 已投递给 Chief"));
  assert.equal(f.aide.topics.inputStore.storage.canCollect("personal", f.aide.topics.inputStore.get("a")!), false);
  await f.project();
  const first = f.aide.topics.inputStore.get("a")!;
  assert.equal(f.root().status.chiefWorkload?.completed, 1, "member projection cannot count again");
  assert.ok(first.status.assess?.completedAt);
  assert.equal(first.status.assess?.executionId, "one");
  await f.project(); assert.equal(f.aide.topics.inputStore.get("a")!.metadata.resourceVersion, first.metadata.resourceVersion);
  assert.equal(f.aide.topics.inputStore.get("later")!.status.assess?.completedAt, undefined);
});

for (const attention of [InputAttention.Normal, InputAttention.Immediate]) test(`${attention} never becomes a Batch even after the deadline`, async t => {
  const f = await secretaryFixture(t); const first = await f.input("a", attention); await f.input("b", attention);
  await prepareInputs(f.context, f.root(), f.policy, Date.parse(first.metadata.creationTimestamp) + 700_000);
  assert.equal((await f.resources.list(BATCH_TYPE)).length, 0);
  assert.equal((await preparedIntake(f.resources, f.root())).inputs.length, 1);
});

test("Gate accepts individual Inputs even when Deferred materials reach the batch threshold", async t => {
  const f = await secretaryFixture(t), gate = f.aide.topics.resource("gate")!;
  const topic = resourceRef(gate);
  for (const [name, attention] of [["first", InputAttention.Deferred], ["second", InputAttention.Deferred], ["coordination", InputAttention.Normal]] as const) {
    await f.resources.create(INPUT_TYPE, { name, spec: { origin: "chief", originId: "fixture", text: name, attention },
      status: { topic, assess: { topic }, route: { completedAt: new Date().toISOString(), result: { topics: [topic], reason: "Gate input" } } } });
  }
  await reconcileSecretary(f.context, gate, f.policy);
  assert.equal((await f.resources.list(BATCH_TYPE)).length, 0);
  assert.deepEqual((await preparedIntake(f.resources, gate, true)).inputs.map(i => i.metadata.name), ["coordination"]);
  await assert.rejects(f.resources.create<BatchSpec, BatchStatus>(BATCH_TYPE, { name: "gate-batch",
    spec: { topic, attention: InputAttention.Normal, oldestAt: gate.metadata.creationTimestamp }, status: { phase: "preparing" } }), /Only a domain root/);
});

test("Single Deferred ages into a Batch independently of Chief activity", async t => {
  const f = await secretaryFixture(t); const first = await f.input("old");
  const { deadlineClock } = await import("./fixtures/clock.ts");
  const advance = deadlineClock(t);
  await f.resources.patchStatus(f.root(), { execution: { id: "busy", startedAt: new Date().toISOString() } });
  await prepareSecretary(f.context, f.root(), f.policy);
  assert.equal((await f.resources.list(BATCH_TYPE)).length, 0);
  advance(600_001);
  await prepareSecretary(f.context, f.root(), f.policy);
  const batch = (await f.resources.list<BatchSpec, BatchStatus>(BATCH_TYPE))[0]!;
  assert.equal(batch.spec.oldestAt, first.metadata.creationTimestamp); assert.equal(f.calls(), 0);
});

test("Concurrent preparation cannot put a member into two batches", async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b");
  await Promise.allSettled([prepareInputs(f.context, f.root(), f.policy), prepareInputs(f.context, f.root(), f.policy)]);
  const batches = (await f.resources.list<BatchSpec, BatchStatus>(BATCH_TYPE)).filter(b => b.status.phase === "ready");
  assert.equal(batches.length, 1);
  for (const id of ["a", "b"]) assert.equal(f.aide.topics.inputStore.get(id)!.status.batchId, batches[0]!.metadata.uid);
});

test("Incompatible origins remain separate and internal maintenance never batches", async t => {
  const f = await secretaryFixture(t);
  await f.input("a", InputAttention.Deferred, "source", "one"); await f.input("b", InputAttention.Deferred, "source", "two");
  await prepareInputs(f.context, f.root(), f.policy); assert.equal((await f.resources.list(BATCH_TYPE)).length, 0);
  const review = await f.input("review", InputAttention.Normal, "aide:curate");
  await prepareInputs(f.context, f.root(), f.policy, Date.parse(review.metadata.creationTimestamp) + 700_000);
  assert.equal(f.aide.topics.inputStore.get("review")!.status.batchId, undefined);
  assert.equal((await f.resources.list(BATCH_TYPE)).length, 2);
});

for (const failure of ["execution", "receipt"] as const) test(`Batch ${failure} failure retries the same sealed members and projects only terminal results`, async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b"); await prepareInputs(f.context, f.root(), f.policy);
  const batch = (await preparedIntake(f.resources, f.root())).batch!;
  await reconcileChief(f.context, f.execution("failure", async () => {
    if (failure === "execution") throw new Error("provider failed");
    await recordDelivery({ ...f.resources, async commit() { throw new Error("receipt write failed"); } }, f.root(), "failure", "failure");
  }), f.root(), f.policy);
  assert.equal((await batchById(f.resources, batch.metadata.uid))!.status.phase, "ready");
  assert.equal(f.aide.topics.inputStore.get("a")!.status.assess?.lastError, undefined);
  await f.project();
  assert.equal(f.aide.topics.inputStore.get("a")!.status.assess?.lastError, undefined);
  assert.equal((await preparedIntake(f.resources, f.root())).inputs.length, 0, "retry waits for the trigger interval");
  const retry = (await batchById(f.resources, batch.metadata.uid))!;
  await f.resources.patchStatus(retry, { assess: { ...retry.status.assess, errorAt: new Date(Date.now() - 61_000).toISOString() } });
  await f.input("later");
  await reconcileChief(f.context, f.execution("retry"), f.root(), f.policy);
  const done = (await batchById(f.resources, batch.metadata.uid))!;
  assert.equal(done.status.phase, "completed"); assert.equal(done.status.assess?.executionId, "retry");
  assert.equal(done.status.assess?.lastError, undefined);
  await f.project();
  assert.ok(f.aide.topics.inputStore.get("a")!.status.assess?.completedAt);
  assert.equal(f.aide.topics.inputStore.get("later")!.status.batchId, undefined);
  await reconcileChief(f.context, f.execution("after"), f.root(), f.policy); assert.equal(f.calls(), 2);
});

test("Sealed membership stays immutable through cancellation and retains unprojected evidence", async t => {
  const f = await secretaryFixture(t); const a = await f.input("a"); await f.input("b");
  await assert.rejects(f.resources.patchStatus(a, { batchAt: new Date().toISOString() }), /set or cleared together/);
  await prepareInputs(f.context, f.root(), f.policy);
  const batch = (await preparedIntake(f.resources, f.root())).batch!, member = f.aide.topics.inputStore.get("a")!;
  await assert.rejects(f.resources.patchStatus(member, { batchId: null, batchAt: null } as never), /immutable/);
  await assert.rejects(f.resources.patchStatus(member, { batchAt: new Date(Date.parse(member.status.batchAt!) + 1).toISOString() }), /immutable/);
  const late = await f.input("late");
  await assert.rejects(f.resources.patchStatus(late, { batchId: batch.metadata.uid, batchAt: new Date().toISOString() }), /unavailable/);
  await assert.rejects(f.resources.delete(INPUT_TYPE, member.metadata.name, "v1", { uid: member.metadata.uid, resourceVersion: member.metadata.resourceVersion }), /Finish or cancel Batch/);
  await assert.rejects(f.resources.delete(BATCH_TYPE, batch.metadata.name, "v1", { uid: batch.metadata.uid, resourceVersion: batch.metadata.resourceVersion }), /Finish Batch/);
  await cancelBatch(f.resources, batch, "Owner no longer eligible");
  const cancelled = (await batchById(f.resources, batch.metadata.uid))!;
  await assert.rejects(f.resources.delete(BATCH_TYPE, cancelled.metadata.name, "v1", { uid: cancelled.metadata.uid, resourceVersion: cancelled.metadata.resourceVersion }), /project/);
  await f.project(); assert.equal(f.aide.topics.inputStore.get("a")!.status.batchId, batch.metadata.uid);
  assert.equal(f.aide.topics.inputStore.storage.canCollect("personal", f.aide.topics.inputStore.get("a")!), true);
});

test("Incompatible members roll back the entire readiness transaction", async t => {
  const f = await secretaryFixture(t); const a = await f.input("a"), b = await f.input("b", InputAttention.Deferred, "source", "other");
  const batch = await f.resources.create<BatchSpec, BatchStatus>(BATCH_TYPE, { name: "forged", spec: {
    topic: resourceRef(f.root()), attention: InputAttention.Normal, oldestAt: a.metadata.creationTimestamp }, status: { phase: "preparing" } });
  await assert.rejects(commitStatus(f.resources, [
    ...[a, b].map(resource => ({ operation: "patchStatus" as const, resource, patch: { batchId: batch.metadata.uid, batchAt: new Date().toISOString() } })),
    { operation: "patchStatus", resource: batch, patch: { phase: "ready" } },
  ]), /incompatible/);
  assert.equal(f.aide.topics.inputStore.get("a")!.status.batchId, undefined);
});

test("A delivered Batch releases the queue even when Chief takes no action", async t => {
  const f = await secretaryFixture(t);
  for (const ids of [["a", "b"], ["c", "d"]]) {
    for (const id of ids) await f.input(id);
    await prepareInputs(f.context, f.root(), f.policy);
  }
  const first = (await preparedIntake(f.resources, f.root())).batch!;
  await reconcileChief(f.context, f.execution("one", async () => {
    await recordDelivery(f.resources, f.root(), "one", "one");
    throw new Error("Provider failed after delivery");
  }), f.root(), f.policy);
  assert.equal((await batchById(f.resources, first.metadata.uid))?.status.phase, "completed");
  const next = await preparedIntake(f.resources, f.root());
  assert.deepEqual(next.inputs.map(i => i.metadata.name).sort(), ["c", "d"]);
  await reconcileChief(f.context, f.execution("two"), f.root(), f.policy);
  assert.equal(f.root().status.chiefWorkload?.completed, 2);
});

test("An undelivered Batch yields to waiting work during and after its cooldown", async t => {
  const f = await secretaryFixture(t);
  for (const ids of [["a", "b"], ["c", "d"]]) {
    for (const id of ids) await f.input(id);
    await prepareInputs(f.context, f.root(), f.policy);
  }
  await reconcileChief(f.context, f.execution("miss", async () => {}), f.root(), f.policy);
  for (const delay of [60_000, 0]) {
    assert.deepEqual((await preparedIntake(f.resources, f.root(), false, delay)).inputs.map(i => i.metadata.name).sort(), ["c", "d"]);
  }
});

test("A business assessment during preparation rolls back the Batch membership", async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b");
  await f.resources.patchStatus(f.root(), { execution: { id: "busy", startedAt: new Date().toISOString() } });
  let raced = false;
  const resources = { ...f.resources, async commit(writes: Parameters<typeof f.resources.commit>[0]) {
    if (!raced) { raced = true; await deliverInput(f.resources, f.root(), "busy", "a"); }
    return f.resources.commit(writes);
  } };
  await assert.rejects(prepareInputs({ ...f.context, resources }, f.root(), f.policy), /version conflict/);
  assert.ok(f.aide.topics.inputStore.get("a")!.status.assess?.completedAt);
  assert.equal(f.aide.topics.inputStore.get("b")!.status.batchId, undefined);
});

test("Preparation rollback permits immediate retry without waiting for Batch GC", async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b");
  let failed = false;
  const resources = { ...f.resources, async commit(writes: Parameters<typeof f.resources.commit>[0]) {
    if (!failed) { failed = true; throw new Error("Injected before membership commit"); }
    return f.resources.commit(writes);
  } };
  await assert.rejects(prepareInputs({ ...f.context, resources }, f.root(), f.policy), /Injected/);
  await prepareInputs(f.context, f.root(), f.policy); assert.equal((await preparedIntake(f.resources, f.root())).inputs.length, 2);
});

test("Batch quota exhaustion leaves originals Deferred and retries when capacity is available", async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b");
  f.aide.topics.inputStore.storage.configure({ kinds: { "aide.dev/Batch": { maxCount: 1 } } });
  await prepareInputs(f.context, f.root(), f.policy); await f.input("c"); await f.input("d");
  await prepareInputs(f.context, f.root(), f.policy);
  for (const id of ["c", "d"]) assert.equal(f.aide.topics.inputStore.get(id)!.status.batchId, undefined);
  f.aide.topics.inputStore.storage.configure({ kinds: { "aide.dev/Batch": { maxCount: 2 } } });
  await prepareInputs(f.context, f.root(), f.policy);
  assert.ok(f.aide.topics.inputStore.get("c")!.status.batchId); assert.equal(f.aide.topics.inputStore.list().length, 4);
});

test("Chief can pass original Batch materials to existing Work independently of Batch assessment", async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b");
  const work = await f.aide.work("root").create({ kind: "task", title: "Inspect", instruction: "Read evidence", trigger: null });
  await prepareInputs(f.context, f.root(), f.policy);
  const batch = (await preparedIntake(f.resources, f.root())).batch!;
  await reconcileChief(f.context, f.execution("handoff", async () => {
    const service = f.aide.work("root");
    await assert.rejects(service.appendInput(work.id, { id: "a" }, { action: "pause" }), /Source facts/);
    for (const inputId of ["a", "b"]) await service.appendInput(work.id, { id: inputId });
    assert.equal((await batchById(f.resources, batch.metadata.uid))!.status.phase, "running");
    await recordDelivery(f.resources, f.root(), "handoff", "handoff");
    for (const id of ["a", "b"]) {
      const input = f.aide.topics.inputStore.get(id)!;
      assert.ok(input.status.handle?.[work.uid!]); assert.equal(input.status.assess?.completedAt, undefined);
    }
  }), f.root(), f.policy);
  await f.project();
  for (const id of ["a", "b"]) assert.equal(f.aide.topics.inputStore.get(id)!.status.handle?.[work.uid!]?.completedAt, undefined);
});

// @case Startup catches up terminal Batch receipts even when the original watch notification was lost.
test("Input controller startup projects a completed Batch without invoking Chief again", async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b");
  await prepareInputs(f.context, f.root(), f.policy);
  await reconcileChief(f.context, f.execution(), f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.get("a")!.status.assess?.completedAt, undefined);
  await f.aide.start(); await f.aide.settled();
  assert.ok(f.aide.topics.inputStore.get("a")!.status.assess?.completedAt);
  assert.ok(f.aide.topics.inputStore.get("b")!.status.assess?.completedAt);
  assert.equal(f.calls(), 1);
});

test("Channel promotion preserves fixed Batch membership without granting steer", async t => {
  const f = await secretaryFixture(t); const original = await f.input("a", InputAttention.Deferred, "source", "fixture", { inputKey: "message:a" }); await f.input("b");
  await prepareInputs(f.context, f.root(), f.policy);
  const ready = (await preparedIntake(f.resources, f.root())).batch!;
  const member = f.aide.topics.inputStore.get(original.metadata.name)!;
  await f.resources.replace(member, { ...member.spec, origin: "channel", attention: InputAttention.Immediate }, member.status);
  await prepareInputs(f.context, f.root(), f.policy);
  await f.resources.patchStatus(f.root(), { execution: { id: "busy", startedAt: new Date().toISOString() } });
  const calls: { operation: string; batchId?: string }[] = [];
  const { submitGatePending: submitPending } = await import("../plugins/personal/gate/intake.ts");
  await submitPending(f.context, { verbs: { action: async (_: string, args: { operation: string; batchId?: string }) => {
    calls.push(args); return { state: "success", value: { accepted: true } };
  } } } as unknown as import("@compforge/aide-plugin").ReconcileContext, f.root());
  assert.deepEqual(calls, []);
  assert.equal(ready.status.phase, "ready");
  assert.deepEqual(new Set((await batchMembers(f.resources, ready)).map(i => i.metadata.name)), new Set([original.metadata.name, "b"]));
});

for (const format of ["legacy", "custom"] as const) test(`Recovery restores ${format} delivery exactly once`, async t => {
  const f = await secretaryFixture(t);
  await f.input("a"); await f.input("b");
  await prepareInputs(f.context, f.root(), f.policy);
  const batch = (await preparedIntake(f.resources, f.root())).batch!;
  await reconcileChief(f.context, f.execution("recover", async () => {
    const session = { source: "pi", id: "session" };
    const view = { schema_version: "agent-ledger/session@1" as const, session,
      nodes: [{ id: "user", kind: "input" as const, started_at: f.root().status.execution!.startedAt,
        content: format === "legacy" ? { role: "user", content: [{ type: "text", text: "[aide-input:recover]\nmaterials" }] }
          : { role: "custom", customType: "aide.input", details: { deliveryId: "recover" }, content: "materials" } }] };
    await recoverInputDeliveries(f.resources, f.root(), async () => view);
    await recoverInputDeliveries(f.resources, f.root(), async () => view);
  }), f.root(), f.policy);
  assert.equal((await batchById(f.resources, batch.metadata.uid))?.status.phase, "completed");
  assert.equal(f.root().status.chiefWorkload?.completed, 1);
});
