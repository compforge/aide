import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import pino from "pino";
import { ConversationStore } from "../src/host/conversation/store.ts";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await Bun.sleep(10); }
  assert.fail("Timed out waiting for conversation");
}

test("Channel inputs reference one Message; observations stay out of chat; state and replies survive reopening", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-conversation-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new ConversationStore({ dir });
  const first = store.submit("m1", { conversationId: "group-a", origin: "channel", text: "one-body-only" });
  assert.equal(store.submit("m1", first.spec).metadata.uid, first.metadata.uid);
  const second = store.submit("s1", { conversationId: "watch-a", origin: "source", text: "requirement changed", observation: { id: "req-1" } });
  assert.deepEqual(store.get("watch-a")!.messages, []);
  const raw = JSON.parse(readFileSync(join(dir, "conversations.json"), "utf8"));
  assert.equal(raw.conversations[0].inputs[0].content.messageId, first.status.messages![0]!.id);
  assert.equal(raw.conversations[0].inputs[0].spec.text, undefined);
  assert.equal(readFileSync(join(dir, "conversations.json"), "utf8").split("one-body-only").length, 2);
  const claimed = store.update(first, { phase: "running" });
  assert.throws(() => store.update(first, { phase: "done" }), /version conflict/);
  const reply = { id: "reply", conversationId: "group-a", at: new Date().toISOString(), role: "aide" as const, text: "answer", workId: null };
  assert.throws(() => store.update(claimed, { phase: "done", messages: [{ ...reply, conversationId: "watch-a" }] }), /another conversation/);
  assert.equal(store.input("m1")!.status.phase, "running");
  store.update(claimed, { phase: "done", messages: [reply] });
  const reopened = new ConversationStore({ dir });
  assert.equal(reopened.input("m1")!.status.phase, "done");
  assert.equal(reopened.get("group-a")!.messages.length, 2);
  assert.deepEqual(reopened.get("group-a")!.pendingInputIds, []);
  assert.deepEqual(reopened.input("s1")!.spec, second.spec);
  assert.throws(() => reopened.update(reopened.input("m1")!, { phase: "running" }), /cannot be replayed/);
});

test("Chief serializes inputs within a conversation while another conversation can proceed", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-conversation-queue-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const calls: Array<{ conversationId: string; text: string; prompt: string }> = [];
  const aide = new Aide(root, fakeOptions({ async chief(prompt) {
    const spec = JSON.parse(prompt.split("Input: ")[1]!.split("\n")[0]!);
    calls.push({ ...spec, prompt });
    if (spec.text === "a-first") await gate;
    return `answer:${spec.text}`;
  }, async execute() { throw new Error("Unexpected work"); } }, root), pino({ level: "silent" }));
  t.after(async () => { release(); await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive({ id: "1", conversationId: "feishu:bot:group-a", text: "a-first" });
  await until(() => calls.length === 1);
  await aide.receive({ id: "2", conversationId: "feishu:bot:group-a", text: "a-second" });
  await aide.receive({ id: "1", conversationId: "feishu:bot:group-b", text: "b-first" });
  await until(() => calls.some((call) => call.text === "b-first"));
  assert.equal(calls.some((call) => call.text === "a-second"), false);
  assert.doesNotMatch(calls.find((call) => call.text === "b-first")!.prompt, /a-first|a-second/);
  release(); await aide.settled();
  assert.deepEqual(calls.filter((call) => call.conversationId.endsWith("group-a")).map((call) => call.text), ["a-first", "a-second"]);
  assert.equal(aide.store.conversations.list().length, 2);
  assert.equal(aide.store.resources.list({ apiVersion: "aide.dev/v1alpha1", kind: "ChiefInput" }).length, 0);
  assert.equal(aide.store.resources.list({ apiVersion: "aide.dev/v1alpha1", kind: "Conversation" }).length, 0);
});

test("Startup resumes queued inputs but fails interrupted input without replaying its actions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-conversation-restart-"));
  const calls: string[] = [];
  const options = fakeOptions({ async chief(prompt) { calls.push(prompt); return "finished"; }, async execute() { throw new Error("Unexpected work"); } }, root);
  let aide = new Aide(root, options, pino({ level: "silent" }));
  const active = aide.store.conversations.submit("active", { conversationId: "a", text: "do-not-replay", origin: "channel" });
  aide.store.conversations.update(active, { phase: "running" });
  aide.store.conversations.submit("queued", { conversationId: "b", text: "process-after-restart", origin: "channel" });
  await aide.close();
  aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.start(); await aide.settled();
  assert.equal(calls.length, 1);
  assert.match(calls[0]!, /process-after-restart/);
  assert.doesNotMatch(calls[0]!, /do-not-replay/);
  assert.equal(aide.store.conversations.input("active")!.status.phase, "failed");
  assert.equal(aide.store.conversations.input("queued")!.status.phase, "done");
});
