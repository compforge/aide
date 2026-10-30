import { deliver } from "../plugins/personal/route/delivery.ts";
import { routeByRules } from "../plugins/personal/route/rules.ts";
import { larkAddress } from "../src/channel/address.ts";
import { nextInput } from "../plugins/personal/loop.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { ROUTE_NAME, ROUTE_TYPE, type RouteStatus } from "../plugins/personal/route/model.ts";
import { reconcileRoute } from "../plugins/personal/route/reconcile.ts";
import { INPUT_TYPE } from "../plugins/personal/input/model.ts";
import { TOPIC_TYPE } from "../plugins/personal/topic/model.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
const log = pino({ level: "silent" });
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const source = (text: string, topicId?: string) => ({ origin: "source" as const, originId: "personal.environments", text, ...(topicId ? { topicId } : {}) });
async function waitFor(predicate: () => boolean, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) { assert.ok(Date.now() < deadline, "Route state did not advance"); await Bun.sleep(10); }
}
function setup(t: { after(fn: () => Promise<void>): void }, agent: Parameters<typeof fakeOptions>[0] = { async execute() { throw new Error("No Work expected"); } }) {
  const root = mkdtempSync(join(tmpdir(), "aide-route-"));
  const options = fakeOptions(agent, root);
  const aide = new Aide(root, options, log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  return { aide, root, options };
}
async function route(aide: Aide) {
  return (await aide.runtime.plugins.resourceClient("personal").get<Record<string, never>, RouteStatus>({ ...ROUTE_TYPE, namespace: "v1", name: ROUTE_NAME }))!;
}
function context(aide: Aide): PluginContext {
  return { resources: aide.runtime.plugins.resourceClient("personal"), logger, instance: { config: {} } } as unknown as PluginContext;
}
async function seedRoute(aide: Aide) {
  return aide.runtime.plugins.resourceClient("personal").create<Record<string, never>, RouteStatus>(ROUTE_TYPE, { name: ROUTE_NAME, spec: {}, status: {} });
}

test("rules preserve one stable binding and inherit the original Input without copying to Default", async t => {
  let models = 0;
  const { aide } = setup(t, { async chief() { return "processed"; }, async route() { models++; throw new Error("Rules must not call Route Agent"); }, async execute() { throw new Error("No Work"); } });
  for (const id of ["a", "b"]) await aide.topics.ensure(id);
  await aide.topics.ensure("default");
  await aide.start();
  const original = await aide.personal.topics.submit("original", source("original", "a"));
  await aide.settled();
  const latest = aide.personal.topics.inputStore.get(original.metadata.name)!;
  assert.throws(() => aide.topics.inputStore.update(latest, { route: { ...latest.status.route, result: { topics: [], reason: "rewrite" } } }), /routing receipt is immutable/);
  await aide.personal.topics.submit("followup", { ...source("follow up"), observation: { originalInputId: "original" } });
  await aide.settled();
  assert.equal(models, 0);
  assert.equal(aide.topics.inputs("default").length, 0);
  assert.ok(aide.topics.input("followup", "a"));
  assert.equal(aide.topics.input("followup", "b"), undefined);
  assert.deepEqual(aide.topics.inputStore.list().filter(i => !i.status.route?.completedAt).map(i => i.metadata.name), []);
});

test("Lark Source creates and reuses explicit topics without model routing or a default reply address", async t => {
  const { aide } = setup(t);
  const ctx = context(aide);
  const fallback = await aide.topics.ensure("default");
  const original = await aide.topics.submit("old", source("historical input"));
  await deliver(ctx, original, [fallback.metadata], "old routing decision");
  const topics = ["lark:cli_app:oc_group", "lark:cli_app:oc_group:thread:omt_a",
    "lark:cli_app:oc_group:thread:omt_b", "lark:cli_app:oc_other", "lark:cli_other:oc_group"];
  for (const [index, topicKey] of topics.entries()) {
    const input = await aide.topics.submit(`topic-${index}`, { origin: "source", originId: "personal.lark",
      topicKey, source: larkAddress(index === 4 ? "cli_other" : "cli_app", index === 3 ? "oc_other" : "oc_group"),
      text: "发布策略讨论", observation: { originalInputId: "old" } });
    assert.deepEqual(await Promise.all([routeByRules(ctx, input), routeByRules(ctx, input)]), [true, true]);
    const c = aide.topics.byKey(topicKey)!;
    assert.equal(c.spec.name, "发布策略讨论");
    assert.equal(c.spec.address, undefined);
    assert.deepEqual(aide.topics.inputStore.get(input.metadata.name)!.status.route!.result!.topics.map(c => c.uid), [c.metadata.uid]);
  }
  const topicKey = topics[1]!;
  const first = aide.topics.byKey(topicKey)!;
  const followup = await aide.topics.submit("followup", { origin: "source", originId: "personal.lark",
    topicKey, text: "另一成员的更新", observation: { originalInputId: "old", userId: "ou_another" } });
  await Promise.all([routeByRules(ctx, followup), routeByRules(ctx, followup)]);
  assert.equal(aide.topics.byKey(topicKey)!.metadata.uid, first.metadata.uid);
  assert.equal(aide.topics.inputs(first.spec.id).length, 2);
  assert.equal(aide.topics.inputs("default").length, 1);
  await assert.rejects(ctx.resources.delete(TOPIC_TYPE, first.metadata.name), /pending Input/);
  const pending = await aide.topics.submit("deleting", { origin: "source", originId: "personal.lark", topicKey, text: "wait" });
  await routeByRules(ctx, pending);
  assert.ok(aide.topics.inputStore.get("deleting")!.status.route?.completedAt);
});

test("semantic routing selects one Topic, fallback goes only to Default, and finished inputs leave the global queue", async t => {
  let calls = 0;
  const { aide } = setup(t, { async execute() { throw new Error("No Work"); }, async route(prompt) {
    calls++;
    const data = JSON.parse(prompt);
    const matches = data.topics.filter((c: { id: string }) => ["a", "b"].includes(c.id));
    return JSON.stringify({ decisions: data.inputs.map((i: { id: string }) => ({ inputId: i.id,
      topicUids: i.id === "shared" ? matches.slice(0, 1).map((c: { uid: string }) => c.uid) : [], reason: "Relevant topics" })) });
  } });
  for (const id of ["a", "b"]) await aide.topics.ensure(id);
  await aide.topics.ensure("default"); await aide.start();
  await aide.personal.topics.submit("shared", source("cross-topic event"));
  await aide.settled();
  assert.equal(calls, 1);
  assert.ok(aide.topics.input("shared", "a"));
  assert.equal(aide.topics.input("shared", "b"), undefined);
  assert.equal(aide.topics.input("shared", "default"), undefined);
  assert.equal(aide.topics.resource("unknown-source-topic"), undefined);
  await aide.personal.topics.submit("fallback", source("unmatched")); await aide.settled();
  assert.ok(aide.topics.input("fallback", "default"));
  assert.equal(aide.topics.input("fallback", "a"), undefined);
  assert.equal((await route(aide)).status.execution, null);
  assert.equal((await route(aide)).status.agent?.harness, "route");
  await aide.personal.topics.submit("shared", source("cross-topic event")); await aide.settled();
  assert.equal(calls, 2);
});

test("empty catalog establishes Default without model execution or an inferred reply address", async t => {
  const { aide } = setup(t);
  await aide.start();
  await aide.personal.topics.submit("first", source("first observation"));
  await aide.settled();
  const fallback = aide.topics.list().find(c => c.default)!;
  assert.ok(fallback);
  assert.equal(fallback.address, undefined);
  assert.ok(aide.topics.input("first", fallback.id));
  assert.deepEqual(aide.topics.inputStore.list().filter(i => !i.status.route?.completedAt).map(i => i.metadata.name), []);
});

test("a model wait does not block rule matches and concurrent arrivals survive routing completion", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let routing = false;
  const { aide } = setup(t, { async execute() { throw new Error("No Work"); }, async route(prompt) {
    routing = true; await gate;
    const data = JSON.parse(prompt);
    return JSON.stringify({ decisions: data.inputs.map((i: { id: string }) => ({ inputId: i.id, topicUids: [], reason: "fallback" })) });
  } });
  t.after(async () => { release(); });
  await aide.topics.ensure("a"); await aide.start();
  await aide.personal.topics.submit("slow", source("needs understanding"));
  await waitFor(() => routing);
  await aide.personal.topics.submit("fast", source("known topic", "a"));
  await waitFor(() => aide.personal.topics.inputStore.get("fast")?.status.route?.completedAt !== undefined);
  assert.equal(aide.personal.topics.inputStore.get("slow")!.status.route?.completedAt, undefined);
  await aide.personal.topics.submit("next", source("new unknown event"));
  await waitFor(() => !!aide.topics.inputStore.get("next"));
  release(); await aide.settled();
  assert.equal(aide.personal.topics.inputStore.get("next")!.status.route?.completedAt !== undefined, true);
  assert.deepEqual(aide.topics.inputStore.list().filter(i => !i.status.route?.completedAt).map(i => i.metadata.name), []);
});

test("recovery discovers input committed before Route existed and routes it on startup", async t => {
  const { aide, root, options } = setup(t);
  await aide.topics.ensure("known");
  await aide.personal.topics.submit("persisted", source("unknown"));
  await aide.close();
  const restarted = new Aide(root, options, log);
  t.after(() => restarted.close());
  await restarted.start();
  await waitFor(() => restarted.personal.topics.inputStore.get("persisted")?.status.route?.completedAt !== undefined);
  await restarted.settled();
  assert.deepEqual(restarted.topics.inputStore.list().filter(i => !i.status.route?.completedAt).map(i => i.metadata.name), []);
});

test("routing is atomic: failed commit leaves no ownership or receipt; retry records one destination", async t => {
  const { aide } = setup(t);
  const a = await aide.topics.ensure("a"), b = await aide.topics.ensure("b");
  const input = await aide.topics.submit("fanout", source("shared"));
  const ctx = context(aide);
  const failing = { ...ctx, resources: { ...ctx.resources, async commit() { throw new Error("disk unavailable"); } } };
  await assert.rejects(deliver(failing, input, [a.metadata], "shared"), /disk unavailable/);
  assert.deepEqual(aide.topics.inputStore.get("fanout")!.status, input.status);
  await deliver(ctx, input, [a.metadata], "shared");
  const committed = aide.topics.inputStore.get("fanout")!;
  assert.equal(committed.status.assess!.topic!.uid, a.metadata.uid);
  assert.equal(committed.status.route!.result!.topics.length, 1);
  assert.ok(committed.status.route?.completedAt);
  await deliver(ctx, input, [b.metadata], "different retry must not change the decision");
  assert.deepEqual(aide.topics.inputStore.get("fanout"), committed);
});

test("a deleted candidate cannot redirect a decision to its replacement", async t => {
  const { aide } = setup(t);
  const c = await aide.topics.ensure("target");
  const input = await aide.topics.submit("pending", source("event"));
  const ctx = context(aide);
  await ctx.resources.delete(TOPIC_TYPE, c.metadata.name);
  aide.personal.store.resources.finalizeDeletion(TOPIC_TYPE, c.metadata.name);
  const replacement = await aide.topics.ensure("target");
  assert.notEqual(c.metadata.uid, replacement.metadata.uid);
  await assert.rejects(deliver(ctx, input, [c.metadata], "pinned"), /no longer exists/);
  assert.deepEqual(aide.topics.inputStore.get("pending")!.status, input.status);
  assert.deepEqual(aide.topics.get("target")!.pendingInputIds, []);
});

test("due Route retries compete with fresh arrivals and an undecided predecessor does not block followup", async t => {
  const { aide } = setup(t);
  await aide.topics.ensure("known");
  const owner = await seedRoute(aide);
  const first = await aide.topics.submit("first", source("failed classification"));
  const inputs = aide.topics.inputStore;
  inputs.update(first, { route: { executionId: "old", startedAt: new Date().toISOString(), lastError: "offline", nextAttemptAt: new Date(Date.now() - 1000).toISOString() } });
  await aide.topics.submit("followup", { ...source("discussion"), observation: { originalInputId: "first" } });
  for (let i = 0; i < 3; i++) {
    await aide.topics.submit(`new-${i}`, source("new arrival"));
    assert.equal((await nextInput(context(aide).resources, owner))!.metadata.name, "first");
  }
  const latest = inputs.get("first")!;
  inputs.update(latest, { route: { ...latest.status.route!, nextAttemptAt: new Date(Date.now() + 60000).toISOString() } });
  assert.equal((await nextInput(context(aide).resources, owner))!.metadata.name, "followup");
  const { reconcileRouteAgent } = await import("../plugins/personal/route/reconcile.ts");
  let calls = 0;
  const execution = { executionId: "followup", withContext() { return this; }, verbs: { async harness() { calls++; return { state: "failure" }; } } } as unknown as ReconcileContext;
  await reconcileRouteAgent(context(aide), execution, owner);
  assert.equal(calls, 1);
  assert.ok(inputs.get("followup")!.status.route?.nextAttemptAt);
});

/** @case No topic candidates means no semantic choice, including future arrivals and deleting topics. */
test("only Default routes repeated source inputs without invoking Route; channel creation still takes precedence", async t => {
  let calls = 0;
  const { aide } = setup(t, { async execute() { throw new Error("No Work"); }, async route() { calls++; throw new Error("No routing model needed"); } });
  await aide.topics.ensure("default");
  const deleting = await aide.topics.ensure("deleting");
  await context(aide).resources.delete(TOPIC_TYPE, deleting.metadata.name);
  await aide.start();
  for (let i = 0; i < 3; i++) {
    await aide.topics.submit(`observation-${i}`, source("unknown topic"));
    await aide.settled();
    assert.ok(aide.topics.input(`observation-${i}`, "default"));
  }
  await aide.topics.submit("new-chat", { origin: "channel", originId: "web", text: "new topic", topicId: "chat" });
  await aide.settled();
  assert.ok(aide.topics.input("new-chat", "chat"));
  assert.equal(aide.topics.input("new-chat", "default"), undefined);
  assert.equal(calls, 0);
});

test("Source names initialize Topics once; names never select a Topic or overwrite a Weave parent", async t => {
  const { aide } = setup(t);
  const ctx = context(aide);
  const make = (id: string, topicKey: string, topicName?: string) => aide.topics.submit(id, {
    origin: "source", originId: "personal.lark", topicKey, ...(topicName ? { topicName } : {}), text: "Lark 群内 @：@Me",
  });
  const one = await make("named-one", "lark:app:oc_one", "DBA 优化讨论");
  await Promise.all([routeByRules(ctx, one), routeByRules(ctx, one)]);
  let topic = aide.topics.byKey(one.spec.topicKey!)!;
  assert.equal(topic.spec.name, "DBA 优化讨论");
  const other = await make("named-other", "lark:app:oc_other", "DBA 优化讨论");
  await routeByRules(ctx, other);
  assert.notEqual(aide.topics.byKey(other.spec.topicKey!)!.metadata.uid, topic.metadata.uid);
  const parent = await aide.topics.ensure("parent", undefined, "数据库性能治理");
  topic = await ctx.resources.replace(topic, { ...topic.spec, name: "已整理的主题", parentRef: {
    apiVersion: parent.apiVersion, kind: parent.kind, namespace: parent.metadata.namespace,
    name: parent.metadata.name, uid: parent.metadata.uid,
  } }, topic.status);
  const later = await make("named-later", one.spec.topicKey!, "群的新名称");
  await routeByRules(ctx, later);
  assert.equal(aide.topics.byKey(one.spec.topicKey!)!.spec.name, "已整理的主题");
  assert.equal(aide.topics.resource("parent")!.spec.name, "数据库性能治理");
  assert.equal(aide.topics.byKey(one.spec.topicKey!)!.metadata.uid, topic.metadata.uid);
  const fallback = await make("unnamed", "lark:app:oc_unnamed");
  await routeByRules(ctx, fallback);
  assert.equal(aide.topics.byKey(fallback.spec.topicKey!)!.spec.name, fallback.spec.text);
});
