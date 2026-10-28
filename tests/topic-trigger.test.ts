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
import { topicTrigger, createTriggerInput } from "../plugins/personal/topic/trigger.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "../plugins/personal/topic/model.ts";
import { summaryVersion, understandingVersion } from "../plugins/personal/topic/tree.ts";
import { reconcileChief } from "../plugins/personal/topic/reconcile.ts";
import { InputAttention } from "../plugins/personal/input/model.ts";
import { ChiefTriggerConfigSchema, type ChiefTriggerConfig } from "../agents/chief/config.ts";
import { finalizeExecution } from "../plugins/personal/loop.ts";
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
  const home = mkdtempSync(join(tmpdir(), "aide-topic-trigger-"));
  const options = fakeOptions({ notify: false, async execute() { throw new Error("Unexpected work"); } }, home);
  const aide = new Aide(home, options, log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.topics.ensure("root");
  const resources = aide.runtime.plugins.resourceClient("personal");
  const read = () => aide.topics.resource("root")!;
  const config: { chiefTrigger?: ChiefTriggerConfig } = {};
  const context = { resources: { ...resources }, logger: { info() {}, warn() {}, error() {} }, instance: { config } } as unknown as PluginContext;
  const calls: { prompt: string; sessionId: string }[] = [];
  const hooks: { beforeAssess?: () => Promise<void>; afterAssess?: () => Promise<void>; skipAssessment?: boolean } = {};
  let sequence = 0;
  const run = async (trigger: ChiefTriggerConfig = { intervalSeconds: 60, idleSeconds: 900 }, fail = false) => {
    config.chiefTrigger = trigger;
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
    return reconcileChief(context, execution, read(), trigger);
  };
  const due = () => resources.patchStatus(read(), { nextTriggerAt: past(), idleSince: past() });
  return { aide, resources, context, calls, read, run, due, home, options, hooks };
}

test("Chief trigger defaults and independent settings validate under config.trigger", () => {
  const config = (trigger: unknown) => ConfigSchema.parse({ harnesses: { chief: { config: { trigger } } } }).harnesses.chief.config.trigger;
  assert.deepEqual(topicTrigger(), { enabled: true });
  assert.deepEqual(config({}), { intervalSeconds: 60, idleSeconds: 900 });
  assert.deepEqual(config({ intervalSeconds: 17 }), { intervalSeconds: 17, idleSeconds: 900 });
  assert.deepEqual(config({ idleSeconds: 180 }), { intervalSeconds: 60, idleSeconds: 180 });
  for (const key of ["intervalSeconds", "idleSeconds"]) for (const value of [0, -1, 0.5, "60", 2_147_484])
    assert.throws(() => config({ [key]: value }));
  assert.throws(() => config({ reconcileIntervalSeconds: 60 }));
  assert.deepEqual(config({ backoff: { factor: 2, maxIdleSeconds: 7200 } }), {
    intervalSeconds: 60, idleSeconds: 900, backoff: { factor: 2, maxIdleSeconds: 7200 },
  });
  for (const factor of [0, 1, -2, Infinity, NaN]) assert.throws(() => config({ backoff: { factor, maxIdleSeconds: 7200 } }));
  for (const maxIdleSeconds of [0, 899, 900.5, 2_147_484]) assert.throws(() => config({ backoff: { factor: 2, maxIdleSeconds } }));
});

const backoff = ChiefTriggerConfigSchema.parse({ backoff: { factor: 2, maxIdleSeconds: 7200 } });
const fullyIdle = () => new Date(Date.now() - 7201_000).toISOString();

/** @case Successful empty reviews double the delay, cap it, and atomically survive duplicate finalization and restart. */
test("Quiet review backoff doubles from completion, caps, and persists across restart", async t => {
  const f = await fixture(t);
  for (const [count, delay] of [[1, 1800_000], [2, 3600_000], [3, 7200_000], [4, 7200_000]]) {
    await f.resources.patchStatus(f.read(), { nextTriggerAt: past(), idleSince: fullyIdle() });
    await f.run(backoff);
    const topic = f.read();
    assert.equal(topic.status.idleReviewCount, count);
    assert.equal(Date.parse(topic.status.nextTriggerAt!) - Date.parse(topic.status.idleSince!), delay);
    assert.equal(topic.status.execution, null);
    assert.equal(topic.status.lastInputAt, undefined, "Trigger Inputs never reset backoff or create business activity");
    const executionId = f.aide.topics.inputStore.list().at(-1)!.status.assess!.executionId!;
    await finalizeExecution(f.context, topic, executionId, "");
    assert.equal(f.read().metadata.resourceVersion, topic.metadata.resourceVersion);
    await f.run(backoff);
    assert.equal(f.calls.length, count, "Checks between reviews must not call the model");
  }
  const saved = f.read().status;
  f.options.config.harnesses.chief.config.trigger = backoff;
  await f.aide.close();
  const restarted = new Aide(f.home, f.options, log);
  try {
    await restarted.start(); await restarted.settled();
    const status = restarted.topics.resource("root")!.status;
    assert.equal(status.idleReviewCount, saved.idleReviewCount);
    assert.equal(status.nextTriggerAt, saved.nextTriggerAt);
    assert.equal(restarted.invocations().length, 0);
  } finally { await restarted.close(); }
});

for (const target of ["root", "child"]) for (const attention of [InputAttention.Normal, InputAttention.Deferred])
test(`${attention} ${target} input resets backoff without changing activation semantics`, async t => {
  const f = await fixture(t);
  if (target === "child") {
    const child = await f.aide.topics.ensure("child");
    const attached = await f.resources.replace(child, { ...child.spec, parentRef: resourceRef(f.read()) }, child.status);
    await f.resources.patchStatus(f.read(), { absorbed: { [attached.metadata.uid]: understandingVersion(attached) },
      absorbedSummaries: { [attached.metadata.uid]: summaryVersion(attached) } });
  }
  const idleSince = new Date(Date.now() - 1000).toISOString();
  await f.resources.patchStatus(f.read(), { idleReviewCount: 3, idleSince,
    nextTriggerAt: new Date(Date.now() + 7200_000).toISOString() });
  const input = await f.aide.topics.submit("new-business", { topicId: target, origin: "source", originId: "fixture", attention, text: "new fact" });
  await routeTo(f.resources, f.aide.topics.resource(target)!.metadata, input);
  const arrivedAt = Date.parse(f.read().status.lastInputAt!);
  await f.run(backoff);
  assert.equal(f.read().status.idleReviewCount, 0);
  if (attention === InputAttention.Deferred) {
    assert.equal(f.calls.length, 0, "Resetting backoff must not activate Deferred inputs");
    assert.ok(Date.parse(f.read().status.nextTriggerAt!) <= arrivedAt + 900_000);
    const deadline = f.read().status.nextTriggerAt;
    await f.run(backoff);
    assert.equal(f.read().status.nextTriggerAt, deadline, "Repeated checks must not postpone the deadline");
    await f.due(); await f.run(backoff);
  }
  assert.equal(f.calls.length, 1);
  assert.ok(f.aide.topics.inputStore.get("new-business")!.status.assess!.completedAt);
  assert.equal(f.read().status.idleReviewCount, 0, "A review handling business inputs is not empty");
});

test("Child understanding still activates Chief before the backed-off review deadline", async t => {
  const f = await fixture(t);
  const child = await f.resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, { name: "changed-child",
    spec: { id: "changed-child", parentRef: resourceRef(f.read()) }, status: { summary: "New durable understanding", recent: [], receipts: [] } });
  await f.resources.patchStatus(f.read(), { idleReviewCount: 3, idleSince: new Date().toISOString(),
    nextTriggerAt: new Date(Date.now() + 7200_000).toISOString() });
  await f.run(backoff);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.prompt, /"kind":"absorb"/);
  assert.ok(f.calls[0]!.prompt.includes(child.metadata.uid));
  assert.equal(f.read().status.idleReviewCount, 0);
  assert.equal(f.aide.topics.inputStore.list().length, 0, "Event activation needs no timer Input");
});

test("A business followUp admitted during a review resets backoff even after its receipt completes", async t => {
  const f = await fixture(t);
  await f.resources.patchStatus(f.read(), { nextTriggerAt: past(), idleSince: fullyIdle(), idleReviewCount: 2 });
  f.hooks.beforeAssess = async () => {
    const input = await f.aide.topics.submit("followup", { topicId: "root", origin: "channel", originId: "fixture", text: "new request" });
    await routeTo(f.resources, f.read().metadata, input);
    const execution = f.read().status.execution!;
    await f.resources.patchStatus(f.aide.topics.inputStore.get("followup")!, { assess: { executionId: execution.id, startedAt: execution.startedAt } });
    await f.resources.patchStatus(f.read(), { execution: { ...execution, admissionRevision: 1 } });
  };
  await f.run(backoff);
  assert.ok(f.aide.topics.inputStore.get("followup")!.status.assess!.completedAt);
  assert.equal(f.read().status.idleReviewCount, 0);
});

test("Deferred arrival during inference prevents backoff growth and waits for another activation", async t => {
  const f = await fixture(t);
  await f.resources.patchStatus(f.read(), { nextTriggerAt: past(), idleSince: fullyIdle(), idleReviewCount: 2 });
  f.hooks.afterAssess = async () => {
    const input = await f.aide.topics.submit("late", { topicId: "root", origin: "source", originId: "fixture", attention: InputAttention.Deferred, text: "late fact" });
    await routeTo(f.resources, f.read().metadata, input);
  };
  await f.run(backoff);
  assert.equal(f.read().status.idleReviewCount, 0);
  assert.equal(f.aide.topics.inputStore.get("late")!.status.assess!.executionId, undefined);
  assert.equal(Date.parse(f.read().status.nextTriggerAt!) - Date.parse(f.read().status.idleSince!), 900_000);
});

test("Business arrival racing the final commit wins over a quiet review", async t => {
  const f = await fixture(t);
  await f.due();
  let once = true;
  f.context.resources.commit = async writes => {
    if (once && writes.some(w => w.operation === "patchStatus" && w.resource.kind === "Topic" && w.patch.idleReviewCount === 1)) {
      once = false;
      const input = await f.aide.topics.submit("race", { topicId: "root", origin: "source", originId: "fixture", attention: InputAttention.Deferred, text: "arrived at commit" });
      await routeTo(f.resources, f.read().metadata, input);
    }
    return f.resources.commit(writes);
  };
  await f.run(backoff);
  assert.equal(once, false);
  assert.equal(f.read().status.idleReviewCount, 0);
  assert.equal(f.read().status.execution, null);
  assert.equal(Date.parse(f.read().status.nextTriggerAt!) - Date.parse(f.read().status.idleSince!), 900_000);
});

for (const mode of ["failure", "missing_receipt", "interrupted"] as const)
test(`${mode} cannot advance quiet-review backoff`, async t => {
  const f = await fixture(t);
  await f.resources.patchStatus(f.read(), { nextTriggerAt: past(), idleSince: fullyIdle(), idleReviewCount: 2 });
  if (mode === "interrupted") await f.resources.patchStatus(f.read(), { execution: { id: "interrupted", startedAt: past() } });
  if (mode === "missing_receipt") f.hooks.skipAssessment = true;
  await f.run(backoff, mode === "failure");
  assert.equal(f.read().status.idleReviewCount, 0);
  assert.equal(f.read().status.execution, null);
  assert.equal(Date.parse(f.read().status.nextTriggerAt!) - Date.parse(f.read().status.idleSince!), 900_000);
  if (mode !== "interrupted") assert.ok(f.aide.topics.inputStore.list()[0]!.status.assess!.lastError);
});

test("Disabling and re-enabling review clears backoff and starts a base idle period", async t => {
  const f = await fixture(t);
  await f.resources.patchStatus(f.read(), { idleReviewCount: 3, idleSince: fullyIdle(), nextTriggerAt: past() });
  await f.aide.setTopicTrigger("root", false);
  await f.run(backoff);
  assert.equal(f.read().status.idleReviewCount, 0);
  assert.equal(f.read().status.nextTriggerAt, null);
  await f.aide.setTopicTrigger("root", true);
  await f.run(backoff);
  assert.equal(f.calls.length, 0);
  assert.equal(Date.parse(f.read().status.nextTriggerAt!) - Date.parse(f.read().status.idleSince!), 900_000);
});

test("Removing backoff configuration restores the base cadence instead of retaining a long deadline", async t => {
  const f = await fixture(t);
  await f.resources.patchStatus(f.read(), { idleReviewCount: 3, idleSince: past(),
    nextTriggerAt: new Date(Date.now() + 7200_000).toISOString() });
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.read().status.idleReviewCount, 0);
  await f.run();
  assert.equal(f.calls.length, 1);
});

test("Web persists per-Topic enablement; cadence belongs to Chief", async t => {
  const f = await fixture(t);
  await f.aide.topics.ensure("other");
  const server = httpChannel(f.aide, log); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown) => fetch(base + "/topics/trigger", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ topicId: "missing", enabled: true })).status, 404);
  assert.equal((await post({ topicId: "root", enabled: true, intervalSeconds: 1 })).status, 400);
  assert.equal((await post({ topicId: "root", enabled: false })).status, 200);
  assert.equal(f.read().status.nextTriggerAt, null);
  const rows = await (await fetch(base + "/topics")).json() as { items: { id: string; trigger: { enabled: boolean } }[] };
  assert.equal(rows.items.find(row => row.id === "other")!.trigger.enabled, true);
  await f.aide.close();
  const reopened = new Aide(f.home, f.options, log);
  try { assert.deepEqual(reopened.topics.resource("root")!.spec.trigger, { enabled: false }); }
  finally { await reopened.close(); }
});

test("Idle review is a pre-routed Input with a processing receipt and Job View, without refreshing business activity", async t => {
  const f = await fixture(t);
  await f.due();
  const before = f.read().status.lastInputAt;
  await f.run();
  const input = f.aide.topics.inputStore.list()[0]!;
  assert.equal(input.spec.origin, "trigger");
  assert.equal(input.spec.attention, InputAttention.Normal);
  assert.deepEqual(input.status.route!.result!.topics, [resourceRef(f.read())]);
  assert.equal(input.status.route!.executionId, undefined, "No Route model invocation");
  assert.ok(input.status.assess!.completedAt);
  assert.equal(f.read().status.lastInputAt, before);
  assert.ok(f.read().status.idleSince);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.prompt, /System-scheduled reflection/);
  assert.match(f.calls[0]!.prompt, /Scheduled review at/);
  assert.match(f.calls[0]!.prompt, /memory/);
  assert.equal(f.aide.inputDefinition(input.spec).label, "定时回顾");
  assert.equal(inputList(f.aide, { origin: "trigger" }).items.length, 1);
  assert.ok(inputDetail(f.aide, input.metadata.name)!.timeline.some(e => e.stage === "assess" && e.status === "completed"));
  assert.equal((await inputJob(input, [])).status, "completed");
  assert.deepEqual(inputDetail(f.aide, input.metadata.name)!.sessions, [f.read().status.agent], "admission retains the native session even without completing tool evidence");
  assert.ok(topicView(f.aide, "root").blocks.some(b => b.origin === "trigger" && b.label === "定时回顾"));
  await f.run();
  assert.equal(f.calls.length, 1);
});

test("Checks advance independently of idle eligibility; Deferred arrivals do not postpone review", async t => {
  const f = await fixture(t);
  const idleSince = new Date(Date.now() - 30_000).toISOString();
  await f.resources.patchStatus(f.read(), { nextTriggerAt: past(), idleSince });
  const before = Date.now();
  await f.run({ intervalSeconds: 17, idleSeconds: 60 });
  assert.equal(f.calls.length, 0);
  assert.ok(Date.parse(f.read().status.nextTriggerAt!) >= before + 17_000);
  const deferred = await f.aide.topics.submit("observation", { topicId: "root", origin: "source", originId: "personal.environments", attention: InputAttention.Deferred, text: "unchanged environment" });
  await routeTo(f.resources, f.read().metadata, deferred);
  assert.equal(f.read().status.idleSince, idleSince);
  await f.resources.patchStatus(f.read(), { nextTriggerAt: past() });
  await f.run({ intervalSeconds: 17, idleSeconds: 20 });
  assert.equal(f.calls.length, 1);
  assert.ok(f.aide.topics.inputStore.get("observation")!.status.assess!.completedAt);
  const finishedAt = f.read().status.idleSince;
  await f.resources.patchStatus(f.read(), { nextTriggerAt: past() });
  await f.run({ intervalSeconds: 17, idleSeconds: 20 });
  assert.equal(f.calls.length, 1, "A completed review restarts the idle period");
  assert.equal(f.read().status.idleSince, finishedAt);
});

test("Pending normal input replaces timer activation and resets idle time", async t => {
  const f = await fixture(t);
  await f.due();
  const input = await f.aide.topics.submit("normal", { topicId: "root", origin: "source", originId: "personal.environments", text: "needs attention" });
  await routeTo(f.resources, f.read().metadata, input);
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.aide.topics.inputStore.list().filter(i => i.spec.origin === "trigger").length, 0);
  await f.resources.patchStatus(f.read(), { nextTriggerAt: past() });
  await f.run();
  assert.equal(f.calls.length, 1);
});

test("Creation is atomic and a normal arrival during creation joins the same execution", async t => {
  const f = await fixture(t);
  await f.due();
  const commit = f.resources.commit.bind(f.resources);
  f.context.resources.commit = async writes => {
    const result = await commit(writes);
    if (writes.some(w => w.operation === "create" && w.type.kind === "Input")) {
      const input = await f.aide.topics.submit("concurrent", { topicId: "root", origin: "source", originId: "personal.environments", text: "concurrent message" });
      await routeTo(f.resources, f.read().metadata, input);
    }
    return result;
  };
  await f.run(); await f.run();
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.prompt, /concurrent message/);
  assert.equal(f.aide.topics.inputStore.list().length, 2);
  assert.ok(f.aide.topics.inputStore.list().every(i => i.status.assess!.completedAt));
});

test("Repeated stale checks cannot duplicate an Input; a restart before admission consumes it once", async t => {
  const f = await fixture(t);
  await f.due();
  const stale = f.read(), next = new Date(Date.now() + 60_000).toISOString();
  await createTriggerInput(f.context, stale, next);
  await assert.rejects(createTriggerInput(f.context, stale, next), /version conflict/);
  assert.equal(f.aide.topics.inputStore.list().length, 1);
  await f.aide.close();
  const restarted = new Aide(f.home, f.options, log);
  try {
    await restarted.start(); await restarted.settled();
    assert.equal(restarted.invocations().filter(i => i.topicId === "root").length, 1);
    const inputs = restarted.topics.inputStore.list();
    assert.equal(inputs.length, 1);
    assert.ok(inputs[0]!.status.assess!.completedAt);
  } finally { await restarted.close(); }
});

for (const mode of ["failure", "restart"] as const) test(`${mode} starts a fresh idle period without replaying missed checks`, async t => {
  const f = await fixture(t);
  await f.due();
  if (mode === "restart") await f.resources.patchStatus(f.read(), { execution: { id: "interrupted", startedAt: past() } });
  await f.run(undefined, mode === "failure");
  assert.equal(f.read().status.execution, null);
  assert.ok(Date.parse(f.read().status.idleSince!) > Date.now() - 2000);
  const count = f.calls.length;
  await f.resources.patchStatus(f.read(), { nextTriggerAt: past() });
  await f.run();
  assert.equal(f.calls.length, count);
});

test("Runner checks default-enabled roots from creation, skips busy periods, and reuses the native session", { timeout: 12_000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-trigger-runner-"));
  let ticks = 0, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const options = fakeOptions({ notify: false, chief: async () => { ticks++; if (ticks === 1) await gate; return "Nothing needs action"; }, async execute() { throw new Error("Unexpected work"); } }, home);
  options.config.harnesses.chief.config.trigger = { intervalSeconds: 1, idleSeconds: 1 };
  const aide = new Aide(home, options, log);
  t.after(async () => { release(); await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.topics.ensure("root"); await aide.start();
  await until(() => ticks === 1);
  const sessionId = aide.topics.resource("root")!.status.agent!.sessionId;
  await Bun.sleep(1200);
  assert.equal(ticks, 1);
  assert.equal(aide.topics.inputStore.list().length, 1, "No timer backlog while busy");
  release(); await aide.settled();
  await Bun.sleep(200);
  assert.equal(ticks, 1, "No immediate catch-up turn");
  await until(() => ticks === 2); await aide.settled();
  assert.equal(aide.topics.resource("root")!.status.agent!.sessionId, sessionId);
  assert.equal(aide.topics.inputStore.list().length, 2);
  assert.equal(aide.topics.resource("root")!.status.lastInputAt, undefined);
  await aide.setTopicTrigger("root", false); await aide.settled();
  await Bun.sleep(1100);
  assert.equal(ticks, 2);
});


test("Idle trigger reviews Note-only child progress without requiring a summary rewrite", async t => {
  const f = await fixture(t);
  const child = await f.resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, { name: "note-child",
    spec: { id: "note-child", parentRef: resourceRef(f.read()) }, status: { summary: "Stable child rule", recent: [], receipts: [] } });
  await f.resources.patchStatus(f.read(), { summary: "Stable parent rule",
    absorbed: { [child.metadata.uid]: understandingVersion(child) }, absorbedSummaries: { [child.metadata.uid]: summaryVersion(child) } });
  const at = new Date().toISOString();
  await f.resources.patchStatus(child, { recent: [{ id: "deployment", createdAt: at, updatedAt: at, text: "Deployment is 50% complete" }] });
  await f.run();
  assert.equal(f.calls.length, 0, "Note changes do not activate summary maintenance");
  await f.due();
  await f.run();
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0]!.prompt, /System-scheduled reflection/);
  assert.ok(f.calls[0]!.prompt.includes(child.metadata.uid), "Scheduled input includes pending child context for review");
  assert.match(f.calls[0]!.prompt, /confirm absorbed versions without summary/);
  assert.equal(f.read().status.summary, "Stable parent rule");
  const review = f.aide.topics.inputStore.list().find(i => i.spec.origin === "trigger")!;
  assert.ok(review.status.assess!.completedAt);
});

/** @case Concurrent summary observation retries eligibility before creating an idle-review Input. */
test("Idle review retries after concurrent observation without dispatching a stale review", async t => {
  const f = await fixture(t);
  await f.due();
  let conflict = true;
  f.context.resources.commit = async writes => {
    if (conflict && writes.some(w => w.operation === "create" && w.type.kind === "Input")) {
      conflict = false;
      await f.resources.patchStatus(f.read(), { summaryDependencies: {} });
    }
    return f.resources.commit(writes);
  };
  assert.deepEqual(await f.run(), { requeueAfterMs: 1 });
  assert.equal(f.aide.topics.inputStore.list().length, 0);
  assert.equal(f.calls.length, 0);
  await f.run();
  assert.equal(f.aide.topics.inputStore.list().length, 1);
  assert.equal(f.calls.length, 1);
});
