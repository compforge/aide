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
  assert.equal(f.calls(), 0); assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.batch).length, 1);
  await reconcileChief(f.context, f.execution(), f.root(), f.policy); assert.equal(f.calls(), 1);
});

test("Secretary prepares durable review evidence and settles it once after execution", async t => {
  const f = await secretaryFixture(t); const child = await f.aide.topics.ensure("child");
  await f.resources.replace(child, { ...child.spec, parentRef: resourceRef(f.root()) }, child.status);
  await patchSummary(f.resources, f.aide.topics.resource("child")!, { summary: "new understanding" });
  await reconcileSecretary(f.context, f.root(), f.policy);
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:review")!;
  assert.ok(review.spec.maintenance?.materialVersion); assert.equal(f.calls(), 0);
  await reconcileChief(f.context, f.execution(), f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.get(review.metadata.name)!.status.preparationSettledAt, undefined);
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.ok(f.aide.topics.inputStore.get(review.metadata.name)!.status.preparationSettledAt);
  const count = f.root().status.idleReviewCount;
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.root().status.idleReviewCount, count);
  assert.equal(f.calls(), 1);
});

test("Age promotion allows maintenance before fresh Normal business without changing tool origin", async t => {
  const f = await secretaryFixture(t);
  const review = await f.input("review", InputAttention.Normal, "aide:review");
  await f.resources.patchStatus(review, { promotedAt: new Date().toISOString() });
  await f.input("business", InputAttention.Normal);
  await reconcileChief(f.context, f.execution(), f.root(), f.policy);
  assert.ok(f.aide.topics.inputStore.get("review")!.status.assess?.completedAt);
  assert.equal(f.aide.topics.inputStore.get("business")!.status.assess?.executionId, undefined);
});

// @case Structure notification is acknowledged only by successful review, but failures still back off.
test("Secretary prepares while Chief is busy and failed structure review does not hot-loop", async t => {
  const f = await secretaryFixture(t);
  await f.resources.patchStatus(f.root(), { execution: { id: "busy", startedAt: new Date().toISOString() }, weaveRevision: 1 });
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.calls(), 0);
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:review")!;
  assert.ok(review.spec.maintenance); assert.ok(f.root().status.nextAbsorbAt);
  await f.resources.patchStatus(f.root(), { execution: null });
  await reconcileChief(f.context, f.execution("failure", async () => { throw new Error("provider failed"); }), f.root(), f.policy);
  await reconcileSecretary(f.context, f.root(), f.policy);
  await reconcileSecretary(f.context, f.root(), f.policy);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:review").length, 1);
  assert.equal(f.root().status.notifiedWeaveRevision ?? 0, 0);
  assert.ok(f.aide.topics.inputStore.get(review.metadata.name)!.status.preparationSettledAt);
});
