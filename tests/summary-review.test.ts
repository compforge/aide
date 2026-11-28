import assert from "node:assert/strict";
import test from "node:test";
import { checkSummary } from "../plugins/personal/secretary/summary.ts";
import { reconcileChief } from "../plugins/personal/chief/reconcile.ts";
import { SummaryOwnerSchema } from "../plugins/personal/input/review.ts";
import { InputAttention } from "../plugins/personal/input/model.ts";
import { patchSummary } from "./summary-fixture.ts";
import { secretaryFixture } from "./secretary-fixture.ts";
import { prepareInputs } from "../plugins/personal/secretary/batching.ts";
import { deliverInput } from "./input-state-fixture.ts";
import { ensureDefaultTopic } from "../plugins/personal/topic/default.ts";
import { webAddress } from "../src/channel/address.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { upsertTopicNote } from "../plugins/personal/topic/state.ts";

const interval = 15 * 60_000;
function schedule(f: Awaited<ReturnType<typeof secretaryFixture>>) {
  const gate = () => f.aide.topics.resource("gate")!;
  const start = Math.floor(Date.parse(gate().metadata.creationTimestamp) / interval) * interval;
  return {
    tick: async (minutes: number) => {
      const now = start + minutes * 60_000;
      await checkSummary(f.context, gate(), now);
      for (const root of [f.root(), await ensureDefaultTopic(f.resources)]) await checkSummary(f.context, gate(), now, root);
      return (await checkSummary(f.context, gate(), now)).requeueAfterMs;
    },
    requests: () => f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:summary"),
  };
}

test("Secretary skips a busy quarter-hour, ignores mid-slot wakeups and completes a no-op with the owner's receipt", async t => {
  const f = await secretaryFixture(t), s = schedule(f);
  await patchSummary(f.resources, f.root(), { summary: "Supported scope" });
  const version = f.root().status.summaryRevision;
  await f.resources.patchStatus(f.root(), { execution: { id: "busy", startedAt: new Date().toISOString() } });
  await s.tick(15);
  await f.resources.patchStatus(f.root(), { execution: null });
  assert.equal(await s.tick(18), 12 * 60_000);
  assert.equal(s.requests().length, 0);
  await s.tick(30);
  await s.tick(31);
  assert.equal(s.requests().length, 1);
  const [request] = s.requests();
  assert.equal(SummaryOwnerSchema.parse(request!.spec.observation?.summaryOwner).uid, f.root().metadata.uid);
  assert.match(request!.spec.text, /scope, constraints, decisions and reusable conclusions/);
  await reconcileChief(f.context, f.execution("review", async () => {
    await deliverInput(f.resources, f.root(), "review", request!.metadata.name);
  }), f.root(), f.policy);
  const receipt = s.requests()[0]!.status.assess!;
  assert.ok(receipt.completedAt);
  assert.equal(f.root().status.summaryReviewedAt, receipt.completedAt);
  assert.equal(f.root().status.summaryRevision, version);
  await s.tick(90);
  assert.equal(s.requests().length, 2, "only the current slot is checked after missed ticks");
});

test("Assigned Inputs and prepared Batches each make an idle Chief unavailable", async t => {
  const f = await secretaryFixture(t), s = schedule(f);
  await patchSummary(f.resources, f.root(), { summary: "Current understanding" });
  await f.input("first", InputAttention.Deferred);
  await s.tick(15);
  assert.equal(s.requests().length, 0);
  await f.input("second", InputAttention.Deferred);
  await prepareInputs(f.context, f.root(), f.policy);
  await s.tick(30);
  assert.equal(s.requests().length, 0);
  await reconcileChief(f.context, f.execution("batch"), f.root(), f.policy);
  await s.tick(31);
  assert.equal(s.requests().length, 0);
  await s.tick(45);
  assert.equal(s.requests().length, 1);
});

test("Shared Person and Address become eligible from ordinary Notes and rotate independently of the source Topic", async t => {
  const f = await secretaryFixture(t), s = schedule(f);
  const person = await f.aide.persons.observe({ provider: "test", scope: "summary", id: "reviewer" });
  const address = f.aide.addresses.observe(webAddress("review-place"));
  await f.resources.patchStatus(f.root(), { execution: { id: "draft", startedAt: new Date().toISOString() } });
  await upsertTopicNote(f.resources, f.root(), "draft", { text: "Verified collaboration method", nature: "procedural",
    people: [resourceRef(person)], addresses: [resourceRef(address)] }, "draft");
  await f.resources.patchStatus(f.root(), { execution: null, summaryReviewedAt: new Date().toISOString() });
  const shared = await ensureDefaultTopic(f.resources), seen = new Set<string>();
  for (const minutes of [15, 30]) {
    await s.tick(minutes);
    const request = s.requests().find(i => !i.status.assess?.completedAt)!;
    assert.equal(request.status.assess?.topic?.uid, shared.metadata.uid);
    const owner = SummaryOwnerSchema.parse(request.spec.observation?.summaryOwner);
    assert.match(request.spec.text, owner.kind === "Person" ? /one-off assignments from continuing roles/ : /audience and communication conventions/);
    seen.add(owner.uid);
    const current = () => f.aide.topics.resource("default")!;
    await reconcileChief(f.context, f.execution("shared-" + minutes, async () => {
      await deliverInput(f.resources, current(), "shared-" + minutes, request.metadata.name);
    }), current(), f.policy);
    const updated = await f.resources.get<unknown, { summaryReviewedAt?: string; summaryRevision?: string }>(owner);
    assert.ok(updated?.status.summaryReviewedAt);
    assert.equal(updated.status.summaryRevision, "");
  }
  assert.deepEqual(seen, new Set([person.metadata.uid, address.metadata.uid]));
});

test("A business arrival during Summary selection wins the scheduling transaction", async t => {
  const f = await secretaryFixture(t), s = schedule(f);
  await patchSummary(f.resources, f.root(), { summary: "Existing scope" });
  const gate = f.aide.topics.resource("gate")!;
  const due = (Math.floor(Date.parse(gate.metadata.creationTimestamp) / interval) + 1) * interval;
  const resources = { ...f.resources, async commit(writes: Parameters<typeof f.resources.commit>[0]) {
    if (writes.some(w => w.operation === "create" && w.type.kind === "Input"))
      await f.input("arrived", InputAttention.Immediate);
    return f.resources.commit(writes);
  } };
  await checkSummary({ resources, logger: f.context.logger }, gate, due, f.root());
  assert.equal(s.requests().length, 0);
  assert.equal(f.aide.topics.resource("gate")!.status.summaryCheckAt, new Date(due).toISOString());
});
