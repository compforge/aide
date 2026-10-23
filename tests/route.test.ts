import { deliver } from "../plugins/personal/route/delivery.ts";
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
import { CONVERSATION_TYPE } from "../plugins/personal/conversation/model.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
const log = pino({ level: "silent" });
const logger = { debug() {}, info() {}, warn() {}, error() {} };
const source = (text: string, sessionId?: string) => ({ origin: "source" as const, originId: "personal.environments", text, ...(sessionId ? { sessionId } : {}) });
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

test("rules route only to matched conversations; original Input can fan out without copying to Default", async t => {
  let models = 0;
  const { aide } = setup(t, { async chief() { return "processed"; }, async route() { models++; throw new Error("Rules must not call Route Agent"); }, async execute() { throw new Error("No Work"); } });
  for (const id of ["inbox", "a", "b"]) await aide.conversations.ensure(id);
  await aide.setDefaultConversation("inbox", true);
  await aide.start();
  const original = await aide.personal.conversations.submit("original", source("original", "a"));
  await aide.settled();
  const b = aide.conversations.resource("b")!;
  const latest = aide.personal.conversations.inputStore.get(original.metadata.name)!;
  aide.personal.conversations.inputStore.update(latest, { route: { ...latest.status.route!, result: { ...latest.status.route!.result!, conversations: [...latest.status.route!.result!.conversations, resourceRef(b)] } } });
  await aide.personal.conversations.submit("followup", { ...source("follow up", "b"), observation: { originalInputId: "original" } });
  await aide.settled();
  assert.equal(models, 0);
  assert.equal(aide.conversations.inputs("inbox").length, 0);
  for (const id of ["a", "b"]) assert.ok(aide.conversations.input("followup", id));
  assert.deepEqual(aide.conversations.inputStore.list().filter(i => !i.status.route?.completedAt).map(i => i.metadata.name), []);
});

test("semantic routing fans out, fallback goes only to Default, and finished inputs leave the global queue", async t => {
  let calls = 0;
  const { aide } = setup(t, { async execute() { throw new Error("No Work"); }, async route(prompt) {
    calls++;
    const data = JSON.parse(prompt);
    const matches = data.conversations.filter((c: { id: string }) => ["a", "b"].includes(c.id));
    return JSON.stringify({ decisions: data.inputs.map((i: { id: string }) => ({ inputId: i.id,
      conversationUids: i.id === "shared" ? matches.map((c: { uid: string }) => c.uid) : [], reason: "Relevant topics" })) });
  } });
  for (const id of ["inbox", "a", "b"]) await aide.conversations.ensure(id);
  await aide.setDefaultConversation("inbox", true); await aide.start();
  await aide.personal.conversations.submit("shared", source("cross-topic event", "unknown-source-topic"));
  await aide.settled();
  assert.equal(calls, 1);
  for (const id of ["a", "b"]) assert.ok(aide.conversations.input("shared", id));
  assert.equal(aide.conversations.input("shared", "inbox"), undefined);
  assert.equal(aide.conversations.resource("unknown-source-topic"), undefined);
  await aide.personal.conversations.submit("fallback", source("unmatched")); await aide.settled();
  assert.ok(aide.conversations.input("fallback", "inbox"));
  assert.equal(aide.conversations.input("fallback", "a"), undefined);
  assert.deepEqual((await route(aide)).status, { execution: null });
  await aide.personal.conversations.submit("shared", source("cross-topic event", "unknown-source-topic")); await aide.settled();
  assert.equal(calls, 2);
});

test("empty catalog establishes Default without model execution or an inferred reply address", async t => {
  const { aide } = setup(t);
  await aide.start();
  await aide.personal.conversations.submit("first", source("first observation"));
  await aide.settled();
  const fallback = aide.conversations.list().find(c => c.default)!;
  assert.ok(fallback);
  assert.equal(fallback.address, undefined);
  assert.ok(aide.conversations.input("first", fallback.id));
  assert.deepEqual(aide.conversations.inputStore.list().filter(i => !i.status.route?.completedAt).map(i => i.metadata.name), []);
});

test("a model wait does not block rule matches and concurrent arrivals survive routing completion", async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let routing = false;
  const { aide } = setup(t, { async execute() { throw new Error("No Work"); }, async route(prompt) {
    routing = true; await gate;
    const data = JSON.parse(prompt);
    return JSON.stringify({ decisions: data.inputs.map((i: { id: string }) => ({ inputId: i.id, conversationUids: [], reason: "fallback" })) });
  } });
  t.after(async () => { release(); });
  await aide.conversations.ensure("a"); await aide.start();
  await aide.personal.conversations.submit("slow", source("needs understanding"));
  await waitFor(() => routing);
  await aide.personal.conversations.submit("fast", source("known topic", "a"));
  await waitFor(() => aide.personal.conversations.inputStore.get("fast")?.status.route?.completedAt !== undefined);
  assert.equal(aide.personal.conversations.inputStore.get("slow")!.status.route?.completedAt, undefined);
  await aide.personal.conversations.submit("next", source("new unknown event"));
  await waitFor(() => !!aide.conversations.inputStore.get("next"));
  release(); await aide.settled();
  assert.equal(aide.personal.conversations.inputStore.get("next")!.status.route?.completedAt !== undefined, true);
  assert.deepEqual(aide.conversations.inputStore.list().filter(i => !i.status.route?.completedAt).map(i => i.metadata.name), []);
});

test("recovery discovers input committed before Route existed and routes it on startup", async t => {
  const { aide, root, options } = setup(t);
  await aide.conversations.ensure("known");
  await aide.personal.conversations.submit("persisted", source("unknown"));
  await aide.close();
  const restarted = new Aide(root, options, log);
  t.after(() => restarted.close());
  await restarted.start();
  await waitFor(() => restarted.personal.conversations.inputStore.get("persisted")?.status.route?.completedAt !== undefined);
  await restarted.settled();
  assert.deepEqual(restarted.conversations.inputStore.list().filter(i => !i.status.route?.completedAt).map(i => i.metadata.name), []);
});

test("fanout is atomic: failed commit leaves no assignments; retry records every target once", async t => {
  const { aide } = setup(t);
  const a = await aide.conversations.ensure("a"), b = await aide.conversations.ensure("b");
  const input = await aide.conversations.submit("fanout", source("shared"));
  const ctx = context(aide);
  const failing = { ...ctx, resources: { ...ctx.resources, async commit() { throw new Error("disk unavailable"); } } };
  await assert.rejects(deliver(failing, input, [a.metadata, b.metadata], "shared"), /disk unavailable/);
  assert.deepEqual(aide.conversations.inputStore.get("fanout")!.status, {});
  await deliver(ctx, input, [a.metadata, b.metadata], "shared");
  const committed = aide.conversations.inputStore.get("fanout")!;
  assert.equal(Object.keys(committed.status.assess!).length, 2);
  assert.ok(committed.status.route?.completedAt);
  await deliver(ctx, input, [b.metadata], "different retry must not change the decision");
  assert.deepEqual(aide.conversations.inputStore.get("fanout"), committed);
});

test("a deleted candidate cannot redirect a decision to its replacement", async t => {
  const { aide } = setup(t);
  const c = await aide.conversations.ensure("target");
  const input = await aide.conversations.submit("pending", source("event"));
  const ctx = context(aide);
  await ctx.resources.delete(CONVERSATION_TYPE, c.metadata.name);
  aide.personal.store.resources.finalizeDeletion(CONVERSATION_TYPE, c.metadata.name);
  const replacement = await aide.conversations.ensure("target");
  assert.notEqual(c.metadata.uid, replacement.metadata.uid);
  await assert.rejects(deliver(ctx, input, [c.metadata], "pinned"), /no longer exists/);
  assert.deepEqual(aide.conversations.inputStore.get("pending")!.status, {});
  assert.deepEqual(aide.conversations.get("target")!.pendingInputIds, []);
});

test("due Route retries compete with fresh arrivals and an undecided predecessor does not block followup", async t => {
  const { aide } = setup(t);
  await aide.conversations.ensure("known");
  const owner = await seedRoute(aide);
  const first = await aide.conversations.submit("first", source("failed classification"));
  const inputs = aide.conversations.inputStore;
  inputs.update(first, { route: { executionId: "old", startedAt: new Date().toISOString(), lastError: "offline", nextAttemptAt: new Date(Date.now() - 1000).toISOString() } });
  await aide.conversations.submit("followup", { ...source("discussion"), observation: { originalInputId: "first" } });
  for (let i = 0; i < 3; i++) {
    await aide.conversations.submit(`new-${i}`, source("new arrival"));
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

test("Default fallback creation and user selection preserve one global Default", async t => {
  const { aide } = setup(t);
  await aide.conversations.ensure("chosen");
  const { defaultDestination } = await import("../plugins/personal/route/rules.ts");
  const ctx = context(aide);
  const results = await Promise.allSettled([defaultDestination(ctx), aide.setDefaultConversation("chosen", true)]);
  assert.ok(results.some(result => result.status === "fulfilled"));
  assert.equal(aide.conversations.list().filter(c => c.default).length, 1);
  await aide.setDefaultConversation("chosen", true);
  const chosen = aide.conversations.resource("chosen")!;
  assert.deepEqual(await defaultDestination(ctx), { name: chosen.metadata.name, uid: chosen.metadata.uid });
  await assert.rejects(ctx.resources.create(CONVERSATION_TYPE, { name: "duplicate-default", spec: { id: "duplicate", default: true }, status: { receipts: [] } }), /Default Conversation already exists/);
});
