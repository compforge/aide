import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { ROUTE_NAME, ROUTE_TYPE, type RouteStatus, type RouteBatch } from "../plugins/personal/route/model.ts";
import { reconcileRouteBatch, parseRoutePlan } from "../plugins/personal/route/batch.ts";
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
function context(aide: Aide, batchSize = 1): PluginContext {
  return { resources: aide.runtime.plugins.resourceClient("personal"), logger, instance: { config: { route: { batchSize } } } } as unknown as PluginContext;
}
async function seedRoute(aide: Aide) {
  return aide.runtime.plugins.resourceClient("personal").create<Record<string, never>, RouteStatus>(ROUTE_TYPE, { name: ROUTE_NAME, spec: {}, status: { pendingInputIds: [] } });
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
  aide.personal.conversations.inputStore.update(latest, { deliveries: [...latest.status.deliveries!, b.metadata.uid] });
  await aide.personal.conversations.submit("followup", { ...source("follow up", "b"), observation: { originalInputId: "original" } });
  await aide.settled();
  assert.equal(models, 0);
  assert.equal(aide.conversations.inputs("inbox").length, 0);
  for (const id of ["a", "b"]) assert.ok(aide.conversations.input("followup", id));
  assert.deepEqual((await route(aide)).status.pendingInputIds, []);
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
  assert.deepEqual((await route(aide)).status, { pendingInputIds: [], batch: null });
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
  assert.deepEqual((await route(aide)).status.pendingInputIds, []);
});

test("a model wait does not block rule matches and concurrent arrivals survive batch dequeue", async t => {
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
  await waitFor(() => aide.personal.conversations.inputStore.get("fast")?.status.routing?.phase === "done");
  assert.equal(aide.personal.conversations.inputStore.get("slow")!.status.routing?.phase, undefined);
  await aide.personal.conversations.submit("next", source("new unknown event"));
  await waitFor(() => aide.personal.store.resources.get<Record<string, never>, RouteStatus>(ROUTE_TYPE, ROUTE_NAME).status.pendingInputIds.includes("next"));
  release(); await aide.settled();
  assert.equal(aide.personal.conversations.inputStore.get("next")!.status.routing?.phase, "done");
  assert.deepEqual((await route(aide)).status.pendingInputIds, []);
});

test("recovery discovers input committed before Route existed and flushes a partial batch on its deadline", async t => {
  const { aide, root, options } = setup(t);
  await aide.conversations.ensure("known");
  await aide.personal.conversations.submit("persisted", source("unknown"));
  await aide.close();
  const restarted = new Aide(root, { ...options, config: { ...options.config, plugins: { personal: { route: { batchSize: 10, maxWaitSeconds: 1 }, conversation: { batchSize: 1 } } } } }, log);
  t.after(() => restarted.close());
  await restarted.start();
  await waitFor(() => restarted.personal.store.resources.get<Record<string, never>, RouteStatus>(ROUTE_TYPE, ROUTE_NAME).status.pendingInputIds.includes("persisted"));
  await waitFor(() => restarted.personal.conversations.inputStore.get("persisted")?.status.routing?.phase === "done");
  await restarted.settled();
  assert.deepEqual((await route(restarted)).status.pendingInputIds, []);
});

/** @case A crash after one fanout delivery resumes the pinned plan without a second model call or duplicate consumption. */
test("persisted fanout plan survives restart and partial delivery", async t => {
  const { aide, root } = setup(t);
  const a = await aide.conversations.ensure("a"), b = await aide.conversations.ensure("b");
  const input = await aide.personal.conversations.submit("fanout", source("shared"));
  const initial = await seedRoute(aide);
  const plan = [{ inputId: "fanout", destinations: [a, b].map(c => ({ name: c.metadata.name, uid: c.metadata.uid })), reason: "shared" }];
  const batch: RouteBatch = { id: "saved", inputIds: ["fanout"], createdAt: new Date().toISOString(), phase: "planned", prompt: "unused", candidates: [], plan };
  const client = context(aide).resources;
  await client.patchStatus(initial, { pendingInputIds: ["fanout"], batch });
  const { appendConversationInput } = await import("../plugins/personal/conversation/input.ts");
  await appendConversationInput(client, plan[0]!.destinations[0]!, input);
  await client.patchStatus(aide.conversations.resource("a")!, { pendingInputIds: [] }); // First consumer already finished.
  await aide.close();
  let model = 0;
  const restarted = new Aide(root, fakeOptions({ async execute() { throw new Error("No Work"); }, async route() { model++; throw new Error("Plan must be reused"); } }, root), log);
  t.after(() => restarted.close());
  await restarted.start(); await restarted.settled();
  assert.equal(model, 0);
  assert.deepEqual(restarted.conversations.resource("a")!.status.pendingInputIds, []);
  assert.ok(restarted.conversations.input("fanout", "b"));
  assert.deepEqual((await route(restarted)).status.pendingInputIds, []);
  assert.equal(new InputStore(root).get("fanout")!.status.deliveries!.length, 2);
});

test("a deleted candidate cannot redirect a persisted plan to its replacement", async t => {
  const { aide } = setup(t);
  const c = await aide.conversations.ensure("target");
  await aide.personal.conversations.submit("pending", source("event"));
  const initial = await seedRoute(aide);
  const ctx = context(aide);
  const saved = await ctx.resources.patchStatus(initial, { pendingInputIds: ["pending"], batch: { id: "pinned", inputIds: ["pending"], phase: "planned",
    prompt: "unused", candidates: [], createdAt: new Date().toISOString(), plan: [{ inputId: "pending", destinations: [{ name: c.metadata.name, uid: c.metadata.uid }], reason: "pinned" }] } });
  await ctx.resources.delete(CONVERSATION_TYPE, c.metadata.name);
  aide.personal.store.resources.finalizeDeletion(CONVERSATION_TYPE, c.metadata.name);
  const replacement = await aide.conversations.ensure("target");
  assert.notEqual(c.metadata.uid, replacement.metadata.uid);
  await assert.rejects(reconcileRouteBatch(ctx, {} as ReconcileContext, saved), /no longer exists/);
  assert.deepEqual((await route(aide)).status.pendingInputIds, ["pending"]);
  assert.deepEqual(replacement.status.pendingInputIds, []);
});

test("invalid or incomplete model output cannot acknowledge a batch", () => {
  const batch: RouteBatch = { id: "b", inputIds: ["a", "b"], createdAt: "now", phase: "running", prompt: "", candidates: [{ name: "target", uid: "uid", id: "id", nameHint: "name", summary: "", default: false }] };
  const good = { inputId: "a", conversationUids: ["uid"], reason: "related" };
  for (const decisions of [[good], [good, good], [good, { ...good, inputId: "foreign" }], [good, { ...good, inputId: "b", conversationUids: ["unknown"] }]]) {
    assert.throws(() => parseRoutePlan(JSON.stringify({ decisions }), batch));
  }
  assert.throws(() => parseRoutePlan("not JSON", batch));
  assert.equal(parseRoutePlan(JSON.stringify({ decisions: [good, { ...good, inputId: "b", conversationUids: [] }] }), batch).length, 2);
});

test("invalid judgment retains the batch; restarting judgment can deliver it without dropping inputs", async t => {
  const { aide } = setup(t);
  await aide.conversations.ensure("existing");
  await aide.personal.conversations.submit("pending", source("unknown"));
  const ctx = context(aide);
  const initial = await seedRoute(aide);
  const { reconcileRoute } = await import("../plugins/personal/route/reconcile.ts");
  await reconcileRoute(ctx, initial);
  const execution = (text: string) => ({ verbs: { async harness() {
    return { state: "success", value: { outcome: "completed", invocationId: "fixture", result: { stopReason: "end_turn", finalText: text } } };
  } } }) as unknown as ReconcileContext;
  await assert.rejects(reconcileRouteBatch(ctx, execution('{"decisions":[]}'), await route(aide)), /omitted/);
  assert.deepEqual((await route(aide)).status.pendingInputIds, ["pending"]);
  assert.equal(aide.personal.conversations.inputStore.get("pending")!.status.routing, undefined);
  assert.equal((await route(aide)).status.batch!.phase, "running");
  await reconcileRouteBatch(ctx, execution(JSON.stringify({ decisions: [{ inputId: "pending", conversationUids: [], reason: "unmatched" }] })), await route(aide));
  assert.deepEqual((await route(aide)).status.pendingInputIds, []);
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
  await assert.rejects(ctx.resources.create(CONVERSATION_TYPE, { name: "duplicate-default", spec: { id: "duplicate", default: true }, status: { pendingInputIds: [], receipts: [] } }), /Default Conversation already exists/);
});

test("Route prompt budgets previews and batch size without dropping candidate identities or changing Input facts", async t => {
  const { aide } = setup(t);
  const { routePrompt } = await import("../plugins/personal/route/prompt.ts");
  const { routePolicy } = await import("../plugins/personal/route/config.ts");
  const conversations = [];
  for (const id of ["a", "b", "c"]) conversations.push(await aide.conversations.ensure(id));
  const inputs = [];
  for (let i = 0; i < 3; i++) inputs.push(await aide.personal.conversations.submit(`large-${i}`, source("Large observation ".repeat(1700))));
  const result = routePrompt(inputs, conversations, routePolicy({ contextChars: 8192 }));
  assert.ok(result.prompt.length <= 8192);
  assert.deepEqual(result.candidates.map(c => c.uid), conversations.map(c => c.metadata.uid));
  assert.ok(result.inputIds.length > 0 && result.inputIds.length < inputs.length);
  assert.equal(JSON.parse(result.prompt).inputs[0].truncated, true);
  assert.equal(aide.personal.conversations.inputStore.get("large-0")!.spec.text, inputs[0]!.spec.text);
});
