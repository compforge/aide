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
  const context = { resources: { ...resources }, logger: { info() {}, warn() {}, error() {} }, instance: { config: {} } } as unknown as PluginContext;
  const calls: { prompt: string; sessionId: string }[] = [];
  let sequence = 0;
  const run = async (trigger = { intervalSeconds: 60, idleSeconds: 900 }, fail = false) => {
    const executionId = `run-${++sequence}`;
    const execution = { executionId, withContext() { return this; }, verbs: { async harness(args: { operation?: string; prompt: string; sessionId: string }) {
      if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "native" } };
      calls.push(args);
      if (fail) return { state: "failure", error: "provider disconnected" };
      const admitted = aide.topics.inputStore.list().filter(i => i.status.assess?.executionId === executionId && !i.status.assess?.completedAt);
      await assessAll(resources, read(), executionId, { inputIds: admitted.map(i => i.metadata.name), summary: "Nothing needs action" });
      return { state: "success", value: { result: { stopReason: "end_turn" } } };
    } } } as unknown as ReconcileContext;
    return reconcileChief(context, execution, read(), trigger);
  };
  const due = () => resources.patchStatus(read(), { nextTriggerAt: past(), idleSince: past() });
  return { aide, resources, context, calls, read, run, due, home, options };
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
