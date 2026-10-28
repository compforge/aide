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
import { reconcileChief } from "../plugins/personal/topic/reconcile.ts";
import { InputAttention } from "../plugins/personal/input/model.ts";
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
    const execution = { executionId, withContext() { return this; }, verbs: { async harness(args: { operation?: string; prompt: string; sessionId: string }) {
      if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "native" } };
      calls.push(args);
      if (fail) return { state: "failure", error: "provider disconnected" };
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
  assert.deepEqual(parse({}).review, { idleSeconds: 900 });
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
  assert.ok(f.aide.topics.inputStore.get("first")!.status.assess?.completedAt);
  assert.ok(f.aide.topics.inputStore.get("second")!.status.assess?.completedAt);
  assert.equal(f.read().status.idleReviewReset, null);
  assert.equal(f.read().status.idleReviewCount, 0);
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
  const input = f.aide.topics.inputStore.list().find(i => i.spec.origin === "trigger")!;
  assert.deepEqual(input.status.route!.result!.topics, [resourceRef(f.read())]);
  assert.equal(input.status.route?.executionId, undefined);
  assert.ok(input.status.assess?.completedAt);
  assert.equal(f.read().status.lastInputAt, activity);
  assert.equal((await inputJob(input, [])).status, "completed");
  assert.equal(inputList(f.aide, { origin: "trigger" }).items.length, 1);
  assert.ok(inputDetail(f.aide, input.metadata.name)!.timeline.some(e => e.stage === "assess" && e.status === "completed"));
  assert.ok(topicView(f.aide, "root").blocks.some(b => b.origin === "trigger"));
  await f.run(); assert.equal(f.calls.length, 1);
});

for (const changed of ["summary", "structure", "notes"] as const)
test(`${changed} maintenance is selected from Topic data`, async t => {
  const f = await fixture(t);
  await f.resources.patchStatus(f.read(), { idleSince: new Date().toISOString(), idleReviewCount: 3 });
  if (changed === "structure") await f.resources.patchStatus(f.read(), { weaveRevision: 1 });
  else {
    const child = await f.resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, { name: "child", spec: { id: "child", parentRef: resourceRef(f.read()) },
      status: { summary: changed === "summary" ? "New understanding" : "", recent: [], receipts: [] } });
    if (changed === "notes") {
      await f.resources.patchStatus(f.read(), { absorbedSummaries: { [child.metadata.uid]: summaryVersion(child) } });
      await f.run({ review: backoff }); assert.equal(f.calls.length, 0);
      await f.due();
    }
  }
  await f.run({ review: backoff });
  assert.equal(f.calls.length, 1);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "trigger").length, changed === "notes" ? 1 : 0);
});

test("Material pressure creates a bounded organization Input even without pending assessments", async t => {
  const f = await fixture(t);
  await f.input("one", InputAttention.Normal); await f.input("two", InputAttention.Normal); await f.run();
  await f.due(); await f.run({ maxInput: 1 });
  assert.equal(f.calls.length, 2);
  const input = f.aide.topics.inputStore.list().find(i => i.spec.origin === "trigger")!;
  assert.equal((input.spec.observation!.maintenance as { reason: string }).reason, "organize_material");
  assert.match(input.spec.text, /direct Input and Work ownership/);
});

test("Arrival racing an empty decision invalidates the inspected root and retries without advancing backoff", async t => {
  const f = await fixture(t); await f.due();
  let once = true;
  f.context.resources.commit = async writes => {
    if (once && writes.some(w => w.operation === "patchStatus" && w.resource.kind === "Topic" && w.patch.idleReviewCount === 1)) {
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
  await assert.rejects(createReviewInput(f.context, topic, due, agenda), /version conflict/);
  await f.aide.close();
  const restarted = new Aide(f.home, f.options, log);
  try {
    await restarted.start(); await restarted.settled();
    assert.equal(restarted.invocations().filter(i => i.topicId === "root").length, 1);
    assert.equal(restarted.topics.inputStore.list().length, 2);
    assert.ok(restarted.topics.inputStore.list().every(i => i.status.assess?.completedAt));
  } finally { await restarted.close(); }
});

for (const mode of ["failure", "missing_receipt", "interrupted"] as const)
test(`${mode} resets review waiting without replaying uncertain inputs`, async t => {
  const f = await fixture(t); await f.input("deferred"); await f.due();
  if (mode === "interrupted") await f.resources.patchStatus(f.read(), { execution: { id: "interrupted", startedAt: past() } });
  if (mode === "missing_receipt") f.hooks.skipAssessment = true;
  await f.run({ review: backoff }, mode === "failure");
  assert.equal(f.read().status.execution, null);
  assert.equal(f.read().status.idleReviewCount, 0);
  assert.equal(f.read().status.reviewCheckedAt, null);
  assert.ok(Date.parse(f.read().status.idleSince!) > Date.now() - 2000);
  const calls = f.calls.length; await f.run(); assert.equal(f.calls.length, calls);
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

