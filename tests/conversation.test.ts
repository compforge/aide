import { loadConfig } from "../src/config.ts";
import { emptyConnectors } from "../src/connector-client.ts";
import { SOURCE_TYPE } from "../plugins/personal/source.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import pino from "pino";
import { ConversationStore, seedInput } from "./conversation-fixture.ts";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await Bun.sleep(10); }
  assert.fail("Timed out waiting for conversation");
}

test("Independent Input facts and Personal consumption survive reopening with version guards", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-conversation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ConversationStore({ dir });
  const first = await seedInput(store, "m1", { conversationId: "group-a", origin: "channel", text: "one-body-only" });
  assert.equal(store.inputStore.submit(store.sessionId, "m1", first.spec).metadata.uid, first.metadata.uid);
  await seedInput(store, "s1", { conversationId: "watch-a", origin: "source", text: "requirement changed", observation: { id: "req-1" } });
  assert.deepEqual(store.get("watch-a")!.messages, []);
  assert.equal(JSON.parse(readFileSync(join(dir, "inputs.json"), "utf8")).length, 2);
  const claimed = await store.update(first, { phase: "running" });
  await assert.rejects(store.update(first, { phase: "done" }), /version conflict/);
  const reply = { id: "reply", conversationId: "group-a", at: new Date().toISOString(), role: "aide" as const, text: "answer", workId: null };
  await assert.rejects(store.update(claimed, { phase: "done", messages: [{ ...reply, conversationId: "watch-a" }] }), /another conversation/);
  assert.equal(store.input("m1")!.status.phase, "running");
  await store.update(claimed, { phase: "done", messages: [reply] });
  const reopened = new ConversationStore({ dir });
  assert.equal(reopened.input("m1")!.status.phase, "done");
  assert.equal(reopened.get("group-a")!.messages.length, 2);
  assert.deepEqual(reopened.get("group-a")!.pendingInputIds, []);
  await assert.rejects(reopened.update(reopened.input("m1")!, { phase: "running" }), /cannot be replayed/);
});

test("Chief serializes inputs within a conversation while another conversation can proceed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-conversation-queue-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: Array<{ conversationId: string; text: string; prompt: string }> = [];
  const aide = new Aide(root, fakeOptions({ async chief(prompt) {
    const spec = JSON.parse(prompt.split("Activation: ")[1]!.split("\n")[0]!);
    calls.push({ ...spec, prompt });
    if (spec.text === "a-first") await gate;
    return `answer:${spec.text}`;
  }, async execute() { throw new Error("Unexpected work"); } }, root), pino({ level: "silent" }));
  t.after(async () => { release(); await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive({ id: "1", sessionId: "lark:bot:group-a", conversationId: "lark:bot:group-a", text: "a-first" });
  await until(() => calls.length === 1);
  await aide.receive({ id: "2", sessionId: "lark:bot:group-a", conversationId: "lark:bot:group-a", text: "a-second" });
  await aide.receive({ id: "1", sessionId: "lark:bot:group-b", conversationId: "lark:bot:group-b", text: "b-first" });
  await until(() => calls.some((call) => call.text === "b-first"));
  assert.equal(calls.some((call) => call.text === "a-second"), false);
  assert.doesNotMatch(calls.find((call) => call.text === "b-first")!.prompt, /a-first|a-second/);
  release(); await aide.settled();
  assert.deepEqual(calls.filter((call) => call.conversationId.endsWith("group-a")).map((call) => call.text), ["a-first", "a-second"]);
  assert.equal(aide.conversationIds().length, 2);
  assert.equal(aide.session("lark:bot:group-a").store.resources.list({ apiVersion: "aide.dev/v1alpha1", kind: "ChiefInput" }).length, 0);
  assert.equal(aide.session("lark:bot:group-a").store.resources.list({ apiVersion: "aide.dev/v1alpha1", kind: "Conversation" }).length, 1);
});

test("Startup resumes queued inputs but fails interrupted input without replaying its actions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-conversation-restart-"));
  const calls: string[] = [];
  const options = fakeOptions({ async chief(prompt) { calls.push(prompt); return "finished"; }, async execute() { throw new Error("Unexpected work"); } }, root);
  let aide = new Aide(root, options, pino({ level: "silent" }));
  const active = await seedInput(aide.session("a").conversations, "active", { conversationId: "a", text: "do-not-replay", origin: "channel" });
  await aide.session("a").conversations.update(active, { phase: "running" });
  await seedInput(aide.session("b").conversations, "queued", { conversationId: "b", text: "process-after-restart", origin: "channel" });
  await aide.close();
  aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.start(); await aide.settled();
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /process-after-restart/);
  assert.doesNotMatch(calls[0]!, /do-not-replay/);
  assert.equal(aide.session("a").conversations.input("active")!.status.phase, "failed");
  assert.equal(aide.session("b").conversations.input("queued")!.status.phase, "done");
});

test("Source watches restore independently and are installed only in their assigned Session", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-source-routing-"));
  const path = join(root, "config.yaml");
  writeFileSync(path, JSON.stringify({ connectors: { requirements: { work: { provider: "meego", projectKey: "p", userKeys: ["me"] } } },
    plugins: { personal: { watches: [
      { id: "one", source: "work", sessionId: "source:one", conversationId: "source:one" },
      { id: "two", source: "work", sessionId: "source:two" },
    ] } } }));
  let polls = 0;
  const options = { ...fakeOptions({ execute: async () => { throw new Error("Unexpected execution"); } }, root), config: loadConfig(path),
    connectors: { ...emptyConnectors, requirements: { ...emptyConnectors.requirements, list: async () => { polls++; return []; } } } };
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.start(); await aide.settled();
  assert.ok(polls >= 2);
  const initialPolls = polls;
  await aide.receive({ sessionId: "web:one", conversationId: "web-conv", id: "hello", text: "hello" }); await aide.settled();
  assert.equal(polls, initialPolls);
  assert.equal(aide.session("web:one").store.resources.list(SOURCE_TYPE).length, 0);
  for (const id of ["source:one", "source:two"]) assert.equal(aide.session(id).store.resources.list(SOURCE_TYPE).length, 1);
  assert.equal(aide.findConversation("source:one")!.id, "source:one");
  assert.equal(aide.findConversation("web:one")!.id, "web:one");
  const sourceIds = ["source:one", "source:two"].map((id) => aide.session(id).store.resources.list(SOURCE_TYPE)[0]!.metadata.uid);
  await aide.close();
  aide = new Aide(root, options, pino({ level: "silent" }));
  await aide.start(); await aide.settled();
  assert.equal(aide.sessions().length, 3);
  assert.deepEqual(["source:one", "source:two"].map((id) => aide.session(id).store.resources.list(SOURCE_TYPE)[0]!.metadata.uid), sourceIds);
  assert.equal(aide.session("web:one").store.resources.list(SOURCE_TYPE).length, 0);
  assert.equal(aide.findConversation("source:one")!.id, "source:one");
});


test("Conversation name comes from its first Input, survives restart, and Source-created conversations are named too", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-conversation-name-"));
  const options = fakeOptions({ chief: async () => "收到", execute: async () => { throw new Error("No Work expected"); } }, root);
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const sessionId = "lark:app:group";
  await aide.receive({ id: "first", sessionId, text: "  关注 executor\n部署情况  " });
  await aide.receive({ id: "second", sessionId, text: "换个话题" });
  await aide.settled();
  assert.equal(aide.findConversation(sessionId)!.conversations.resource(sessionId)!.spec.name, "关注 executor 部署情况");
  const source = aide.session("source-name"); await source.start();
  await source.conversations.submit("discovery", { origin: "source", sessionId: "source-name", text: "发现新的需求" });
  await aide.settled();
  assert.equal(source.conversations.resource("source-name")!.spec.name, "发现新的需求");
  await aide.close(); aide = new Aide(root, options, pino({ level: "silent" }));
  await aide.start(); await aide.settled();
  assert.equal(aide.findConversation(sessionId)!.conversations.get(sessionId)!.name, "关注 executor 部署情况");
  assert.equal(aide.findConversation("source-name")!.conversations.get("source-name")!.name, "发现新的需求");
});
