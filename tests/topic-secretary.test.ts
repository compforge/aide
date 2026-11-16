import { assessInput } from "../plugins/personal/topic/assess.ts";
import { BATCH_TYPE } from "../plugins/personal/batch/model.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { secretaryFixture } from "./secretary-fixture.ts";
import { reconcileSecretary } from "../plugins/personal/topic/secretary.ts";
import { reconcileChief } from "../plugins/personal/topic/reconcile.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { InputAttention } from "../plugins/personal/input/model.ts";
import { patchSummary } from "./summary-fixture.ts";

test("Chief ignores unprepared Deferred; Secretary produces a batch without invoking Harness", async t => {
  const f = await secretaryFixture(t); await f.input("a"); await f.input("b");
  await reconcileChief(f.context, f.execution(), f.root(), f.policy);
  assert.equal(f.calls(), 0); assert.equal(f.aide.topics.inputStore.list().length, 2);
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.calls(), 0); assert.equal((await f.resources.list(BATCH_TYPE)).length, 1);
  await reconcileChief(f.context, f.execution(), f.root(), f.policy); assert.equal(f.calls(), 1);
});

test("Chief commits review results and scheduling facts once without Secretary settlement", async t => {
  const f = await secretaryFixture(t); const child = await f.aide.topics.ensure("child");
  await f.resources.replace(child, { ...child.spec, parentRef: resourceRef(f.root()) }, child.status);
  await patchSummary(f.resources, f.aide.topics.resource("child")!, { summary: "new understanding" });
  await reconcileSecretary(f.context, f.root(), f.policy);
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:review")!;
  assert.ok(review.spec.observation?.review); assert.equal(f.calls(), 0);
  await reconcileChief(f.context, f.execution(), f.root(), f.policy);
  assert.ok(f.aide.topics.inputStore.get(review.metadata.name)!.status.assess?.completedAt);
  assert.equal(f.root().status.reviewedMaterialVersion, (review.spec.observation!.review as { materialVersion: string }).materialVersion);
  assert.equal(f.root().status.idleReviewCount, 1);
  const count = f.root().status.idleReviewCount;
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.root().status.idleReviewCount, count);
  assert.equal(f.calls(), 1);
});

test("Maintenance remains an independent Input behind ordinary business", async t => {
  const f = await secretaryFixture(t);
  await f.input("review", InputAttention.Normal, "aide:review");
  await f.input("business", InputAttention.Normal);
  await reconcileChief(f.context, f.execution(), f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.get("review")!.status.assess?.executionId, undefined);
  assert.ok(f.aide.topics.inputStore.get("business")!.status.assess?.completedAt);
  assert.equal((await f.resources.list(BATCH_TYPE)).length, 0);
});

// @case Structure notification is acknowledged only by successful review, but failures still back off.
test("Secretary prepares while Chief is busy and failed structure review does not hot-loop", async t => {
  const f = await secretaryFixture(t);
  await f.resources.patchStatus(f.root(), { execution: { id: "busy", startedAt: new Date().toISOString() }, weaveRevision: 1 });
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.calls(), 0);
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:review")!;
  assert.ok(review.spec.observation?.review); assert.ok(f.root().status.nextAbsorbAt);
  await f.resources.patchStatus(f.root(), { execution: null });
  await reconcileChief(f.context, f.execution("failure", async () => { throw new Error("provider failed"); }), f.root(), f.policy);
  await reconcileSecretary(f.context, f.root(), f.policy);
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:review").length, 1);
  assert.equal(f.root().status.notifiedWeaveRevision ?? 0, 0);
  assert.equal(f.aide.topics.inputStore.get(review.metadata.name)!.status.assess?.retryable, true);
});

// @case A rejected result transaction leaves both Input and maintenance scheduling uncommitted.
test("Review completion failure retries atomically and repeated completion cannot increment backoff", async t => {
  const f = await secretaryFixture(t);
  await f.resources.patchStatus(f.root(), { weaveRevision: 1 });
  await reconcileSecretary(f.context, f.root(), f.policy);
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:review")!;
  await reconcileChief(f.context, f.execution("write-failure", async () => {
    const failing = { ...f.resources, async commit() { throw new Error("receipt store unavailable"); } };
    await assessInput(failing, f.root(), "write-failure", { inputId: review.metadata.name, summary: "checked" });
  }), f.root(), f.policy);
  const pending = f.aide.topics.inputStore.get(review.metadata.name)!;
  assert.equal(pending.status.assess?.completedAt, undefined);
  assert.equal(pending.status.assess?.retryable, true);
  assert.equal(f.root().status.notifiedWeaveRevision ?? 0, 0);
  assert.equal(f.root().status.idleReviewCount ?? 0, 0);
  await f.resources.patchStatus(pending, { assess: { ...pending.status.assess, errorAt: new Date(Date.now() - 61_000).toISOString() } });
  await reconcileChief(f.context, f.execution("retry", async () => {
    const args = { inputId: review.metadata.name, summary: "checked" };
    await assessInput(f.resources, f.root(), "retry", args);
    const after = f.root();
    assert.equal(after.status.notifiedWeaveRevision, 1);
    assert.equal(after.status.idleReviewCount, 1);
    await assessInput(f.resources, f.root(), "retry", args);
    assert.equal(f.root().metadata.resourceVersion, after.metadata.resourceVersion);
  }), f.root(), f.policy);
  assert.ok(f.aide.topics.inputStore.get(review.metadata.name)!.status.assess?.completedAt);
  const receipt = f.aide.topics.inputStore.get(review.metadata.name)!;
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.get(review.metadata.name)!.metadata.resourceVersion, receipt.metadata.resourceVersion);
  // A later structure change is a new task with a new Input identity.
  await f.resources.patchStatus(f.root(), { weaveRevision: 2, nextAbsorbAt: new Date(0).toISOString() });
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:review").length, 2);
});

// @case A conflicting scheduling update rolls back the receipt, then recomputes the counter exactly once.
test("Maintenance completion retries a conflicting Topic write atomically", async t => {
  const f = await secretaryFixture(t);
  await f.resources.patchStatus(f.root(), { weaveRevision: 1 });
  await reconcileSecretary(f.context, f.root(), f.policy);
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:review")!;
  let raced = false, rolledBack = false;
  await reconcileChief(f.context, f.execution("race", async () => {
    const resources = { ...f.resources, async commit(writes: Parameters<typeof f.resources.commit>[0]) {
      if (!raced) {
        raced = true;
        await f.resources.patchStatus(f.root(), { idleReviewCount: 5 });
        try { return await f.resources.commit(writes); }
        catch (error) {
          rolledBack = true;
          assert.equal(f.aide.topics.inputStore.get(review.metadata.name)!.status.assess?.completedAt, undefined);
          assert.equal(f.root().status.notifiedWeaveRevision ?? 0, 0);
          throw error;
        }
      }
      return f.resources.commit(writes);
    } };
    await assessInput(resources, f.root(), "race", { inputId: review.metadata.name, summary: "checked" });
    assert.equal(f.root().status.idleReviewCount, 6);
    assert.equal(f.root().status.notifiedWeaveRevision, 1);
  }), f.root(), f.policy);
  assert.ok(raced && rolledBack);
  assert.ok(f.aide.topics.inputStore.get(review.metadata.name)!.status.assess?.completedAt);
});
