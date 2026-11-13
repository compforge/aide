import { newHarnessError } from "@compforge/aide-plugin";
import { NOTE_TYPE, type NoteSpec, type NoteStatus } from "../plugins/personal/note/model.ts";
import { reconcileNote } from "../plugins/personal/note/reconcile.ts";
import { createWithSummary, patchSummary } from "./summary-fixture.ts";
import { committedStatus } from "./fixtures/resource-write.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import pino from "pino";
import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { httpChannel } from "../src/api/index.ts";
import { inputDetail, inputList } from "../src/api/inputs.ts";
import { topicView } from "../src/channel/view.ts";
import { inputJob } from "../plugins/personal/observation/job.ts";
import { topicReview, createReviewInput, idleReviewSchedule } from "../plugins/personal/topic/review.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "../plugins/personal/topic/model.ts";
import { summaryVersion, understandingVersion } from "../plugins/personal/topic/tree.ts";
import { reconcileAssignments } from "../plugins/personal/topic/assignment.ts";
import { reconcileChief, reconcileTopic } from "../plugins/personal/topic/reconcile.ts";
import { INPUT_TYPE, InputAttention, type InputSpec, type InputStatus } from "../plugins/personal/input/model.ts";
import { finalizeExecution } from "../plugins/personal/loop.ts";
import { topicPolicy, TopicReviewPolicySchema, type TopicPolicy } from "../plugins/personal/topic/config.ts";
import { maintenanceAgenda } from "../plugins/personal/topic/maintenance.ts";
import { parsePersonalConfig } from "../plugins/personal/config.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { fakeOptions } from "./fake-harness.ts";
import { assessAll, routeTo } from "./input-state-fixture.ts";

const log = pino({ level: "silent" });
const past = () => new Date(Date.now() - 901_000).toISOString();
async function until(check: () => boolean) {
  for (let i = 0; i < 200; i++) { if (check()) return; await Bun.sleep(20); }
  assert.ok(check(), "condition did not become true");
}
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = mkdtempSync(join(tmpdir(), "aide-topic-review-"));
  const options = fakeOptions({ notify: false, async execute() { throw new Error("Unexpected work"); } }, home);
  const aide = new Aide(home, options, log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.topics.ensure("root");
  const resources = aide.runtime.plugins.resourceClient("personal");
  const read = () => aide.topics.resource("root")!;
  const config = { topic: topicPolicy({}) };
  const context = { resources: { ...resources }, logger: { info() {}, warn() {}, error() {} }, instance: { config } } as unknown as PluginContext;
  const calls: { prompt: string; sessionId: string }[] = [];
  const hooks: { beforeAssess?: () => Promise<void>; afterAssess?: () => Promise<void>; skipAssessment?: boolean } = {};
  let sequence = 0;
  const run = async (policy: Partial<TopicPolicy> = {}, fail = false) => {
    config.topic = topicPolicy({ ...config.topic, ...policy });
    const executionId = `run-${++sequence}`;
    const execution = { executionId, withContext() { return this; }, verbs: { async action() { return { state: "success", value: { streaming: false } }; }, async harness(args: { operation?: string; prompt: string; sessionId: string }) {
      if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "native" } };
      calls.push(args);
      if (fail) throw newHarnessError("harness_execution_failed", "provider disconnected");
      await hooks.beforeAssess?.();
      const admitted = aide.topics.inputStore.list().filter(i => i.status.assess?.executionId === executionId && !i.status.assess?.completedAt);
      if (!hooks.skipAssessment) await assessAll(resources, read(), executionId, { inputIds: admitted.map(i => i.metadata.name), summary: "Nothing needs action" });
      await hooks.afterAssess?.();
      return { state: "success", value: { result: { stopReason: "end_turn" } } };
    } } } as unknown as ReconcileContext;
    return reconcileChief(context, execution, read(), config.topic);
  };
  const due = () => resources.patchStatus(read(), { reviewCheckedAt: null, idleReviewReset: null, idleSince: new Date(Date.now() - 7201_000).toISOString() });
  const input = async (id: string, attention = InputAttention.Deferred) => {
    const fact = await aide.topics.submit(id, { topicId: "root", origin: "source", originId: "personal.events", attention, text: id });
    await routeTo(resources, read().metadata, fact);
    return aide.topics.inputStore.get(id)!;
  };
  return { aide, resources, context, calls, read, run, due, home, options, hooks, input, config };
}

const backoff = TopicReviewPolicySchema.parse({ backoff: { factor: 2, maxIdleSeconds: 7200 } });

test("Topic owns independent trigger and review policies; Harness and misplaced keys reject business scheduling", () => {
  const parse = (topic: unknown) => parsePersonalConfig(ConfigSchema.parse({ plugins: { personal: { topic } } }).plugins.personal).topic!;
  assert.deepEqual(topicReview(), { enabled: true });
  assert.deepEqual(parse({}).trigger, { intervalSeconds: 60 });
  assert.deepEqual(parse({}).review, { idleSeconds: 900, backoff: { factor: 2, maxIdleSeconds: 7200 } });
  assert.deepEqual(parse({ review: { backoff: null } }).review, { idleSeconds: 900, backoff: null });
  assert.equal(parse({ review: { idleSeconds: 8000 } }).review.backoff!.maxIdleSeconds, 8000);
  assert.deepEqual(parse({ trigger: { intervalSeconds: 17 }, review: backoff }).review, backoff);
  assert.throws(() => parse({ trigger: { backoff: { factor: 2, maxIdleSeconds: 7200 } } }));
  assert.throws(() => parse({ review: { intervalSeconds: 60 } }));
  assert.throws(() => ConfigSchema.parse({ harnesses: { chief: { config: { trigger: {} } } } }));
  for (const value of [0, -1, 0.5, "60", 2_147_484]) {
    assert.throws(() => parse({ trigger: { intervalSeconds: value } }));
    assert.throws(() => parse({ review: { idleSeconds: value } }));
  }
  for (const factor of [0, 1, -2, Infinity, NaN]) assert.throws(() => parse({ review: { backoff: { factor, maxIdleSeconds: 7200 } } }));
  assert.throws(() => parse({ review: { backoff: { factor: 2, maxIdleSeconds: 899 } } }));
});

test("Empty due checks back off without Inputs or inference; fixed wakeups do not advance the count", async t => {
  const f = await fixture(t);
  for (const [count, delay] of [[1, 1800_000], [2, 3600_000], [3, 7200_000], [4, 7200_000]]) {
    await f.due();
    const result = await f.run({ trigger: { intervalSeconds: 17 }, review: backoff });
    assert.equal(result!.requeueAfterMs, 17000);
    assert.equal(f.read().status.idleReviewCount, count);
    assert.equal(Date.parse(idleReviewSchedule(f.read(), backoff).dueAt) - Date.parse(f.read().status.reviewCheckedAt!), delay);
    const saved = f.read();
    await f.run();
    assert.equal(f.read().metadata.resourceVersion, saved.metadata.resourceVersion, "Intermediate ticks do not move the deadline or write state");
  }
  assert.equal(f.calls.length, 0);
  assert.equal(f.aide.topics.inputStore.list().length, 0);
  assert.equal(f.read().status.lastInputAt, undefined);
});

for (const scenario of [
  { name: "lower cap", elapsed: 45, count: 3, idle: 15, factor: 2, max: 30, due: true },
  { name: "raise cap", elapsed: 45, count: 3, idle: 15, factor: 2, max: 120, due: false },
  { name: "lower factor", elapsed: 60, count: 3, idle: 15, factor: 1.5, max: 120, due: true },
  { name: "raise factor", elapsed: 60, count: 3, idle: 15, factor: 2, max: 120, due: false },
  { name: "lower base", elapsed: 25, count: 2, idle: 5, factor: 2, max: 120, due: true },
  { name: "raise base", elapsed: 45, count: 2, idle: 15, factor: 2, max: 120, due: false },
]) test(`Current review policy applies to elapsed waiting: ${scenario.name}`, async t => {
  const f = await fixture(t);
  const since = new Date(Date.now() - scenario.elapsed * 60_000).toISOString();
  await f.resources.patchStatus(f.read(), { idleSince: since, reviewCheckedAt: since, idleReviewCount: scenario.count });
  const policy = TopicReviewPolicySchema.parse({ idleSeconds: scenario.idle * 60,
    backoff: { factor: scenario.factor, maxIdleSeconds: scenario.max * 60 } });
  await f.run({ review: policy });
  assert.equal(f.read().status.idleReviewCount, scenario.count + Number(scenario.due));
  const saved = f.read(); await f.run();
  assert.equal(f.read().metadata.resourceVersion, saved.metadata.resourceVersion);
  if (!scenario.due) assert.equal(f.read().status.reviewCheckedAt, since);
  assert.equal(f.calls.length, 0);
});

test("First deferred arrival resets waiting without activating Chief or allowing later arrivals to postpone it", async t => {
  const f = await fixture(t);
  const since = Date.now() - 110 * 60_000;
  await f.resources.patchStatus(f.read(), { idleSince: new Date(since).toISOString(), idleReviewCount: 3 });
  await f.input("first");
  const arrival = f.read().status.lastInputAt!;
  await f.run({ review: backoff });
  assert.equal(f.calls.length, 0);
  assert.deepEqual(f.read().status.idleReviewReset, { at: arrival, previousCount: 3 });
  assert.equal(f.read().status.idleReviewCount, 0);
  const due = idleReviewSchedule(f.read(), backoff).dueAt;
  assert.equal(due, new Date(since + 7200_000).toISOString());
  await f.input("second"); await f.run();
  assert.equal(idleReviewSchedule(f.read(), backoff).dueAt, due);
  const longer = TopicReviewPolicySchema.parse({ idleSeconds: 1800, backoff: { factor: 2, maxIdleSeconds: 14400 } });
  assert.equal(idleReviewSchedule(f.read(), longer).dueAt, new Date(Date.parse(arrival) + 1800_000).toISOString());
  await f.due(); await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.aide.topics.inputStore.get("first")!.status.assess?.completedAt, undefined);
  assert.equal(f.aide.topics.inputStore.get("second")!.status.assess?.completedAt, undefined);
  assert.equal(f.read().status.idleReviewReset, null);
  assert.equal(f.read().status.idleReviewCount, 1);
});

for (const attention of [InputAttention.Normal, InputAttention.Immediate])
test(`${attention} business Input bypasses review backoff and needs no synthetic Input`, async t => {
  const f = await fixture(t);
  await f.resources.patchStatus(f.read(), { idleSince: new Date().toISOString(), idleReviewCount: 3 });
  await f.input("business", attention); await f.run({ review: backoff });
  assert.equal(f.calls.length, 1);
  assert.equal(f.aide.topics.inputStore.list().length, 1);
  assert.ok(f.aide.topics.inputStore.get("business")!.status.assess?.completedAt);
  assert.equal(f.read().status.idleReviewCount, 0);
});

test("Due deferred material creates a pre-routed review Input with independent receipt and observation", async t => {
  const f = await fixture(t);
  await f.input("deferred"); await f.due();
  const activity = f.read().status.lastInputAt;
  await f.run();
  const input = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:review")!;
  assert.deepEqual(input.status.route!.result!.topics, [resourceRef(f.read())]);
  assert.equal(input.status.route?.executionId, undefined);
  assert.ok(input.status.assess?.completedAt);
  assert.equal(f.read().status.lastInputAt, activity);
  assert.equal((await inputJob(input, [])).status, "completed");
  assert.equal(inputList(f.aide, { origin: "aide:review" }).items.length, 1);
  assert.ok(inputDetail(f.aide, input.metadata.name)!.timeline.some(e => e.stage === "assess" && e.status === "completed"));
  assert.ok(topicView(f.aide, "root").blocks.some(b => b.origin === "aide:review"));
  await f.run(); assert.equal(f.calls.length, 1);
});

for (const changed of ["summary", "structure", "notes"] as const)
test(`${changed} maintenance is selected from Topic data`, async t => {
  const f = await fixture(t);
  await f.resources.patchStatus(f.read(), { idleSince: new Date().toISOString(), idleReviewCount: 3 });
  if (changed === "structure") await f.resources.patchStatus(f.read(), { weaveRevision: 1 });
  else {
    const child = await createWithSummary<TopicSpec, TopicStatus>(f.resources, TOPIC_TYPE, { name: "child", spec: { id: "child", parentRef: resourceRef(f.read()) },
      status: { summary: changed === "summary" ? "New understanding" : "", receipts: [] } });
    if (changed === "notes") {
      await f.resources.patchStatus(f.read(), { absorbedSummaries: { [child.metadata.uid]: summaryVersion(child) } });
      await f.run({ review: backoff }); assert.equal(f.calls.length, 0);
      await f.due();
    }
  }
  await f.run({ review: backoff });
  assert.equal(f.calls.length, 1);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:review").length, 1);
});

test("Material pressure creates a bounded organization Input even without pending assessments", async t => {
  const f = await fixture(t);
  await f.input("one", InputAttention.Normal); await f.input("two", InputAttention.Normal); await f.run();
  await f.due(); await f.run({ maxUnfiledInput: 1 });
  assert.equal(f.calls.length, 2);
  const input = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:triage")!;
  assert.equal((input.spec.observation!.facts as { reason: string }).reason, "organize_material");
  assert.match(input.spec.text, /direct unfiled Inputs and Work/);
});

test("Arrival racing an empty decision invalidates the inspected root and retries without advancing backoff", async t => {
  const f = await fixture(t); await f.due();
  let once = true;
  f.context.resources.commit = async writes => {
    if (once && writes.some(w => "resource" in w && w.resource.kind === "Topic" && committedStatus(w)?.idleReviewCount === 1)) {
      once = false; await f.input("race", InputAttention.Normal);
    }
    return f.resources.commit(writes);
  };
  assert.equal((await f.run({ review: backoff }))!.requeueAfterMs, 1);
  assert.equal(f.read().status.idleReviewCount ?? 0, 0);
  await f.run(); assert.equal(f.calls.length, 1);
  assert.equal(f.aide.topics.inputStore.list().length, 1);
});

test("Review creation is fenced; reopening before admission consumes the existing Input once", async t => {
  const f = await fixture(t); await f.input("deferred"); await f.due();
  const topic = f.read(), due = idleReviewSchedule(topic, backoff).dueAt;
  const agenda = await maintenanceAgenda(f.resources, [topic]);
  await createReviewInput(f.context, topic, due, agenda);
  assert.equal((await createReviewInput(f.context, topic, due, agenda)).metadata.name, f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:review")!.metadata.name);
  // Assignment refresh has its own restart tests; here both materials are ready before admission.
  await reconcileAssignments(f.context, f.read());
  await f.aide.close();
  const restarted = new Aide(f.home, f.options, log);
  try {
    await restarted.start(); await restarted.settled();
    assert.equal(restarted.invocations().filter(i => i.topicId === "root").length, 1);
    assert.equal(restarted.topics.inputStore.list().length, 2);
    assert.ok(restarted.topics.inputStore.list().filter(i => i.spec.origin === "aide:review").every(i => i.status.assess?.completedAt));
    assert.equal(restarted.topics.inputStore.get("deferred")!.status.assess?.executionId, undefined);
  } finally { await restarted.close(); }
});

for (const mode of ["failure", "missing_receipt", "interrupted"] as const)
test(`${mode} finalizes review waiting without replaying uncertain inputs`, async t => {
  const f = await fixture(t); await f.input("deferred"); await f.due();
  if (mode === "interrupted") await f.resources.patchStatus(f.read(), { execution: { id: "interrupted", startedAt: past() } });
  if (mode === "missing_receipt") f.hooks.skipAssessment = true;
  await f.run({ review: backoff }, mode === "failure");
  assert.equal(f.read().status.execution, null);
  assert.equal(f.read().status.idleReviewCount ?? 0, 0);
  assert.equal(f.read().status.reviewCheckedAt, null);
  assert.ok(Date.parse(f.read().status.idleSince!) > Date.now() - 2000);
  const calls = f.calls.length; await f.run(); assert.equal(f.calls.length, calls);
});

test("A later execution failure preserves already completed Input receipts", async t => {
  const f = await fixture(t); await f.input("completed-before-error", InputAttention.Normal);
  f.hooks.afterAssess = async () => { throw new Error("provider failed after acknowledgement"); };
  await f.run();
  const receipt = f.aide.topics.inputStore.get("completed-before-error")!.status.assess!;
  assert.ok(receipt.completedAt);
  assert.equal(receipt.lastError, undefined);
  assert.match(f.read().status.lastError!, /failed after acknowledgement/);
});

// @case Failed internal requests retain their receipts without blocking independent future maintenance.
for (const mode of ["failure", "missing_receipt"] as const)
test(`${mode} review preserves deferred business and permits the next maintenance request`, async t => {
  const f = await fixture(t);
  await f.input("old-deferred"); await f.due();
  f.hooks.skipAssessment = mode === "missing_receipt";
  await f.run({ review: backoff }, mode === "failure");
  const failed = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:review")!;
  const old = f.aide.topics.inputStore.get("old-deferred")!;
  assert.ok(failed.status.assess?.lastError);
  assert.equal(old.status.assess?.executionId, undefined);
  assert.equal(failed.status.assess?.completedAt, undefined);
  for (const name of ["assessPending", "assignedPending", "assessActive"]) {
    const pending = await f.resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
      matchIndex: { name, value: f.read().metadata.uid }, limit: 10 });
    assert.deepEqual(pending.items.map(i => i.metadata.name), name === "assessActive" ? [] : ["old-deferred"], `${name} excludes failed review and preserves business`);
  }
  await f.input("new-deferred");
  await f.run();
  assert.equal(f.calls.length, 1, "failure still observes the review cooldown");
  f.hooks.skipAssessment = false;
  await f.due(); await f.run();
  assert.equal(f.calls.length, 2, "a failed review cannot occupy the next maintenance slot");
  const reviews = f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:review");
  assert.equal(reviews.length, 2);
  assert.ok(reviews.find(i => i.metadata.uid !== failed.metadata.uid)!.status.assess?.completedAt);
  assert.equal(f.aide.topics.inputStore.get("new-deferred")!.status.assess?.executionId, undefined);
  assert.deepEqual(f.aide.topics.inputStore.get(failed.metadata.name)!.status, failed.status);
  assert.deepEqual(f.aide.topics.inputStore.get("old-deferred")!.status, old.status, "failed business Input is not replayed");
});

for (const origin of ["aide:review", "aide:triage", "aide:organize"] as const)
test(`${origin} deduplicates queued and active requests but releases an interrupted request`, async t => {
  const f = await fixture(t);
  const topic = f.read(), agenda = await maintenanceAgenda(f.resources, [topic]);
  const due = "2026-11-01T00:00:00.000Z", later = "2026-11-02T00:00:00.000Z";
  const first = await createReviewInput(f.context, topic, due, agenda, origin);
  assert.equal((await createReviewInput(f.context, f.read(), later, agenda, origin)).metadata.uid, first.metadata.uid);
  const executionId = "interrupted-review";
  await f.resources.commit([
    { operation: "patchStatus", resource: f.read(), patch: { execution: { id: executionId, startedAt: past(), inputOrigin: origin } } },
    { operation: "patchStatus", resource: first, patch: { assess: { ...first.status.assess, executionId, startedAt: past() } } },
  ]);
  assert.equal((await createReviewInput(f.context, f.read(), later, agenda, origin)).metadata.uid, first.metadata.uid);
  await finalizeExecution(f.context, f.read(), executionId);
  const failed = f.aide.topics.inputStore.get(first.metadata.name)!;
  assert.match(failed.status.assess!.lastError!, /interrupted/);
  const pending = await f.resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
    matchIndex: { name: "internalPending", value: JSON.stringify([topic.metadata.uid, origin]) }, limit: 1 });
  assert.equal(pending.items.length, 0);
  const next = await createReviewInput(f.context, f.read(), later, agenda, origin);
  assert.notEqual(next.metadata.uid, first.metadata.uid);
  assert.deepEqual(f.aide.topics.inputStore.get(first.metadata.name)!.status, failed.status);
});

test("Restart preserves empty-check backoff and recalculates it from new policy", async t => {
  const f = await fixture(t);
  const checked = new Date(Date.now() - 2700_000).toISOString();
  await f.resources.patchStatus(f.read(), { idleSince: checked, reviewCheckedAt: checked, idleReviewCount: 3 });
  f.options.config.plugins.personal!.topic = topicPolicy({ review: { backoff: { factor: 2, maxIdleSeconds: 1800 } } });
  await f.aide.close();
  const restarted = new Aide(f.home, f.options, log);
  try {
    await restarted.start();
    await until(() => restarted.topics.resource("root")!.status.idleReviewCount === 4);
    await restarted.settled();
    assert.equal(restarted.topics.resource("root")!.status.idleReviewCount, 4);
    assert.equal(restarted.invocations().length, 0);
    assert.equal(restarted.topics.inputStore.list().length, 0);
  } finally { await restarted.close(); }
});

test("Web review toggle persists independently of periodic wakeup configuration", async t => {
  const f = await fixture(t);
  const server = httpChannel(f.aide, log); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown) => fetch(base + "/topics/review", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ topicId: "missing", enabled: true })).status, 404);
  assert.equal((await post({ topicId: "root", enabled: true, intervalSeconds: 1 })).status, 400);
  await f.due(); await f.run({ review: backoff });
  assert.equal((await post({ topicId: "root", enabled: false })).status, 200);
  const rows = await (await fetch(base + "/topics")).json() as { items: { id: string; review: { enabled: boolean } }[] };
  assert.equal(rows.items.find(row => row.id === "root")!.review.enabled, false);
  assert.equal(f.read().status.idleReviewCount, 0);
  assert.equal(f.read().status.reviewCheckedAt, null);
  assert.equal((await f.run())!.requeueAfterMs, 60000, "Disabling review does not disable periodic reconciliation");
  await f.input("normal", InputAttention.Normal); await f.run(); assert.equal(f.calls.length, 1);
  await f.aide.setTopicReview("root", true); await f.run(); assert.equal(f.calls.length, 1);
});

test("Runner keeps periodic checks while empty reviews back off and event Inputs remain responsive", { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  f.options.config.plugins.personal!.topic = topicPolicy({ trigger: { intervalSeconds: 1 }, review: { idleSeconds: 1, backoff: { factor: 2, maxIdleSeconds: 8 } } });
  await f.aide.close();
  const running = new Aide(f.home, f.options, log);
  try {
    await running.start(); await until(() => (running.topics.resource("root")!.status.idleReviewCount ?? 0) >= 2);
    assert.equal(running.invocations().length, 0);
    const resources = running.runtime.plugins.resourceClient("personal");
    const fact = await running.topics.submit("event", { topicId: "root", origin: "source", originId: "personal.events", text: "new business" });
    await routeTo(resources, running.topics.resource("root")!.metadata, fact);
    await until(() => !!running.topics.inputStore.get("event")!.status.assess?.completedAt);
    await running.settled();
    assert.equal(running.invocations().filter(i => i.topicId === "root").length, 1);
    assert.equal(running.topics.inputStore.list().length, 1);
  } finally { await running.close(); }
});



test("Business Inputs precede capacity maintenance even when idle review is disabled", async t => {
  const f = await fixture(t);
  await f.resources.replace(f.read(), { ...f.read().spec, review: { enabled: false } }, f.read().status);
  await f.input("one", InputAttention.Normal); await f.input("two", InputAttention.Immediate);
  await f.run({ maxUnfiledInput: 1 });
  const request = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:triage")!;
  assert.equal(request.status.assess?.executionId, undefined);
  assert.ok(f.aide.topics.inputStore.get("one")!.status.assess?.completedAt);
  assert.ok(f.aide.topics.inputStore.get("two")!.status.assess?.completedAt);
  assert.ok(f.calls[0]!.prompt.indexOf("two") < f.calls[0]!.prompt.indexOf("one"));
  await f.run();
  assert.equal(f.calls.length, 2);
  assert.ok(f.aide.topics.inputStore.get(request.metadata.name)!.status.assess?.completedAt);
});

test("Immediate intake can steer a running organization pass", async t => {
  const f = await fixture(t);
  for (const name of ["a", "b"]) await createWithSummary(f.resources, TOPIC_TYPE, { name, spec: { id: name, parentRef: resourceRef(f.read()) }, status: { summary: "", receipts: [] } });
  const requests: unknown[] = [];
  f.hooks.beforeAssess = async () => {
    await f.input("arrival", InputAttention.Immediate);
    await reconcileAssignments(f.context, f.read());
    await reconcileTopic(f.context, { verbs: { async action(name: string, args: unknown) {
      requests.push({ name, args }); return { state: "success", value: { accepted: true } };
    } } } as unknown as ReconcileContext, f.read());
  };
  await f.run({ maxChildren: 1 });
  assert.deepEqual(requests, [{ name: "submit_topic", args: { inputId: "arrival", operation: "steer" } }]);
  f.hooks.beforeAssess = undefined;
  await f.run();
  assert.ok(f.aide.topics.inputStore.get("arrival")!.status.assess?.completedAt);
});

test("Idle timer cannot bypass capacity cooldown when an organization pass makes no progress", async t => {
  const f = await fixture(t);
  await f.input("one", InputAttention.Normal); await f.input("two", InputAttention.Normal); await f.run();
  await f.run({ maxUnfiledInput: 1 }); assert.equal(f.calls.length, 2);
  await f.due(); await f.run();
  assert.equal(f.calls.length, 2);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:triage").length, 1);
});

test("A persisted pressure request waits for business without duplicate maintenance", async t => {
  const f = await fixture(t);
  await f.input("one", InputAttention.Normal); await f.input("two", InputAttention.Normal);
  const agenda = await maintenanceAgenda(f.resources, [f.read()], { maxUnfiledInput: 1 });
  const request = await createReviewInput(f.context, f.read(), new Date().toISOString(), agenda, "aide:triage");
  await f.run({ maxUnfiledInput: 1 });
  assert.equal(f.aide.topics.inputStore.get(request.metadata.name)!.status.assess?.executionId, undefined);
  assert.ok(f.aide.topics.inputStore.get("one")!.status.assess?.completedAt);
  await f.run();
  assert.ok(f.aide.topics.inputStore.get(request.metadata.name)!.status.assess?.completedAt);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:triage").length, 1);
});

test("Failed capacity execution retains its claim while waiting business is processed next", async t => {
  const f = await fixture(t);
  await f.input("one", InputAttention.Normal); await f.input("two", InputAttention.Normal);
  await f.run();
  await f.run({ maxUnfiledInput: 1 }, true);
  const request = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:triage")!;
  assert.ok(request.status.assess?.executionId);
  await f.input("later", InputAttention.Normal);
  await f.run();
  assert.ok(f.aide.topics.inputStore.get("later")!.status.assess?.completedAt);
  assert.ok(f.aide.topics.inputStore.get("one")!.status.assess?.completedAt);
  assert.equal(f.aide.topics.inputStore.get(request.metadata.name)!.status.assess?.executionId, request.status.assess?.executionId);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:triage").length, 1);
});

test("Chief activation keeps its character and admission budgets with large pending Inputs", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 10; i++) {
    const fact = await f.aide.topics.submit(`large-${i}`, { topicId: "root", origin: "source", originId: "personal.events", text: "x".repeat(32000) });
    await routeTo(f.resources, f.read().metadata, fact);
  }
  await f.run({ contextChars: 4096 });
  assert.ok(f.calls[0]!.prompt.length <= 4096);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.status.assess?.completedAt).length, 8);
});


async function unabsorbedChild(f: Awaited<ReturnType<typeof fixture>>) {
  const child = await createWithSummary<TopicSpec, TopicStatus>(f.resources, TOPIC_TYPE, { name: "quiet-child",
    spec: { id: "quiet-child", parentRef: resourceRef(f.read()) }, status: { summary: "Stable child knowledge", receipts: [] } });
  await f.resources.patchStatus(f.read(), { absorbedSummaries: { [child.metadata.uid]: summaryVersion(child) } });
  return child;
}

/** @case Idle review completion alone must neither reset backoff nor repeatedly invoke Chief for identical child material. */
test("Acknowledging only the review backs off and unchanged material skips inference across due checks", async t => {
  const f = await fixture(t);
  await unabsorbedChild(f);
  await f.due(); await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.read().status.idleReviewCount, 1);
  assert.ok(f.read().status.reviewedMaterialVersion);
  assert.equal(Date.parse(idleReviewSchedule(f.read(), backoff).dueAt) - Date.parse(f.read().status.idleSince!), 1800_000);
  for (const count of [2, 3, 4]) {
    await f.due(); await f.run();
    assert.equal(f.read().status.idleReviewCount, count);
    assert.equal(f.calls.length, 1);
  }
  assert.equal(f.aide.topics.inputStore.list().length, 1);
  assert.deepEqual(f.read().status.absorbed, {}, "Skipping inference is not a fabricated absorption receipt");
  await f.input("new-deferred"); await f.due(); await f.run();
  assert.equal(f.calls.length, 2, "Unchanged knowledge must not suppress new deferred business");
  assert.equal(f.aide.topics.inputStore.get("new-deferred")!.status.assess?.executionId, undefined);
  assert.equal(f.read().status.idleReviewCount, 1);
});

test("Unchanged summary maintenance skips inference without creating a one millisecond loop", async t => {
  const f = await fixture(t);
  const child = await createWithSummary<TopicSpec, TopicStatus>(f.resources, TOPIC_TYPE, { name: "summary-child",
    spec: { id: "summary-child", parentRef: resourceRef(f.read()) }, status: { summary: "Stable knowledge", receipts: [] } });
  await f.run();
  assert.equal(f.calls.length, 1);
  await f.resources.patchStatus(f.read(), { nextAbsorbAt: past() });
  assert.equal((await f.run())!.requeueAfterMs, 60000);
  assert.equal(f.calls.length, 1);
  await patchSummary(f.resources, child, { summary: "New durable evidence" });
  await f.run();
  assert.equal(f.calls.length, 2, "Changed child knowledge bypasses idle review backoff");
});

test("Completed absorption is progress even without a summary edit", async t => {
  const f = await fixture(t), child = await unabsorbedChild(f);
  await f.resources.patchStatus(f.read(), { idleReviewCount: 3 });
  f.hooks.afterAssess = async () => {
    await f.resources.patchStatus(f.read(), { absorbed: { [child.metadata.uid]: understandingVersion(child) } });
  };
  await f.due(); await f.run();
  assert.equal(f.read().status.idleReviewCount, 0);
  assert.equal(f.read().status.absorbAttempts, 0);
});

test("Material arriving during review remains eligible and the internal receipt cannot hide it", async t => {
  const f = await fixture(t), child = await unabsorbedChild(f);
  f.hooks.afterAssess = async () => { await patchSummary(f.resources, child, { summary: "Changed while Chief was running" }); };
  await f.due(); await f.run();
  assert.equal(f.read().status.idleReviewCount, 0);
  f.hooks.afterAssess = undefined;
  await f.resources.patchStatus(f.read(), { nextAbsorbAt: past() });
  await f.run();
  assert.equal(f.calls.length, 2);
});

for (const mode of ["failure", "missing_receipt"] as const)
test(`A ${mode} does not certify maintenance material as reviewed`, async t => {
  const f = await fixture(t);
  await unabsorbedChild(f);
  if (mode === "missing_receipt") f.hooks.skipAssessment = true;
  await f.due(); await f.run({}, mode === "failure");
  assert.equal(f.read().status.reviewedMaterialVersion, undefined);
});

test("Restart retains reviewed material identity while new Normal input still activates Chief", async t => {
  const f = await fixture(t);
  await unabsorbedChild(f);
  await f.due(); await f.run();
  const version = f.read().status.reviewedMaterialVersion;
  await f.due(); await f.aide.close();
  const restarted = new Aide(f.home, f.options, log);
  try {
    await restarted.start();
    await until(() => restarted.topics.resource("root")!.status.idleReviewCount === 2);
    await restarted.settled();
    assert.equal(restarted.topics.resource("root")!.status.reviewedMaterialVersion, version);
    assert.equal(restarted.invocations().length, 0);
    const resources = restarted.runtime.plugins.resourceClient("personal");
    const input = await restarted.topics.submit("after-restart", { topicId: "root", origin: "source", originId: "test", text: "New business" });
    await routeTo(resources, restarted.topics.resource("root")!.metadata, input);
    await until(() => !!restarted.topics.inputStore.get("after-restart")!.status.assess?.completedAt);
    await restarted.settled();
    assert.equal(restarted.invocations().filter(i => i.topicId === "root").length, 1);
  } finally { await restarted.close(); }
});


test("Acknowledged review without Note changes does not repeatedly review the same queued Note", async t => {
  const f = await fixture(t);
  await f.resources.create(NOTE_TYPE, { name: "matter", spec: { subject: resourceRef(f.read()), text: "A current matter" },
    status: { updatedAt: new Date().toISOString() } });
  const ref = { ...NOTE_TYPE, namespace: "v1", name: "matter" } as const;
  let note = (await f.resources.get<NoteSpec, NoteStatus>(ref))!;
  await reconcileNote(f.context, note);
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.read().status.idleReviewCount, 1);
  assert.equal((await f.resources.get<NoteSpec, NoteStatus>(ref))!.status.reviewed, undefined);
  await f.resources.patchStatus(f.read(), { nextAbsorbAt: past() });
  assert.equal((await f.run())!.requeueAfterMs, 60000);
  assert.equal(f.calls.length, 1);
  note = (await f.resources.get<NoteSpec, NoteStatus>(ref))!;
  note = await f.resources.replace(note, { ...note.spec, text: "New evidence for the matter" }, note.status);
  await reconcileNote(f.context, note);
  await f.run();
  assert.equal(f.calls.length, 2);
});


test("Internal review completion preserves accumulated backoff", async t => {
  const f = await fixture(t);
  await unabsorbedChild(f);
  await f.resources.patchStatus(f.read(), { idleReviewCount: 2 });
  await f.due(); await f.run();
  assert.equal(f.read().status.idleReviewCount, 3);
  assert.equal(Date.parse(idleReviewSchedule(f.read(), backoff).dueAt) - Date.parse(f.read().status.idleSince!), 7200_000);
});
