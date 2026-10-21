import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { SessionStore } from "../src/host/store/store.ts";
import { ConversationStore } from "./conversation-fixture.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { conversationTrigger, ConversationTriggerSchema } from "../plugins/personal/conversation/trigger.ts";
import { CONVERSATION_TYPE } from "../plugins/personal/conversation/model.ts";
import { httpChannel } from "../src/api/index.ts";
import { conversationView } from "../src/channel/view.ts";
import { fakeOptions } from "./fake-harness.ts";

const log = pino({ level: "silent" });
async function until(check: () => boolean) {
  for (let i = 0; i < 160; i++) { if (check()) return; await Bun.sleep(25); }
  assert.ok(check(), "condition did not become true");
}
async function configure(store: ConversationStore, id: string, intervalSeconds: number, due: number) {
  const c = await store.ensure(id);
  return createResourceClient(store.resources).replace(c, { ...c.spec, trigger: { enabled: true, intervalSeconds } },
    { ...c.status, nextTriggerAt: new Date(due).toISOString() });
}

test("Web switches one Conversation, persists its deadline and cannot change the interval", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-conv-trigger-web-"));
  const aide = new Aide(root, fakeOptions({ execute: async () => { throw new Error("No work"); } }, root), log);
  const scope = aide.session("shared");
  await scope.conversations.ensure("a"); await scope.conversations.ensure("b");
  const server = httpChannel(aide, log); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); server.close(); await aide.close(); rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(conversationTrigger(), { enabled: false, intervalSeconds: 3600 });
  for (const intervalSeconds of [0, -1, 0.5]) assert.throws(() => ConversationTriggerSchema.parse({ intervalSeconds }));
  const post = (body: unknown) => fetch(base + "/conversations/trigger", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  assert.equal((await post({ conversationId: "missing", enabled: true })).status, 404);
  assert.equal((await post({ conversationId: "a", enabled: true, intervalSeconds: 1 })).status, 400);
  assert.equal((await post({ conversationId: "a", enabled: true })).status, 200);
  const due = scope.conversations.resource("a")!.status.nextTriggerAt;
  assert.equal((await post({ conversationId: "a", enabled: true })).status, 200);
  assert.equal(scope.conversations.resource("a")!.status.nextTriggerAt, due);
  const rows = await (await fetch(base + "/conversations")).json() as { id: string; trigger: { enabled: boolean; intervalSeconds: number } }[];
  assert.deepEqual(rows.find((row) => row.id === "a")!.trigger, { enabled: true, intervalSeconds: 3600 });
  assert.equal(rows.find((row) => row.id === "b")!.trigger.enabled, false);
  await aide.close();
  const session = new SessionStore(root).openSession("shared");
  const reopened = new ConversationStore(session);
  assert.equal(reopened.resource("a")!.status.nextTriggerAt, due);
  assert.equal("heartbeat" in session.meta, false);
  await session.closeLogs();
});

test("Runner wakes Conversation without an Input; a long timer coalesces and disabling keeps its result", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-conv-trigger-runner-"));
  const session = new SessionStore(root).createSession({ id: "timer", cwd: root });
  const conversations = new ConversationStore(session);
  await configure(conversations, "timer", 1, Date.now() - 20_000);
  let ticks = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const aide = new Aide(root, fakeOptions({ chief: async () => { ticks++; await gate; return "发现值得跟进的进展"; }, execute: async () => { throw new Error("No work"); } }, root), log);
  t.after(async () => { release(); await aide.close(); await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  await aide.start(); await until(() => ticks === 1);
  assert.equal(aide.sessions().flatMap((s) => s.conversations.inputs()).length, 0);
  assert.equal(conversationView(aide, "timer").meta.activity?.phase, "running");
  await Bun.sleep(1100);
  await aide.setConversationTrigger("timer", false);
  release(); await aide.settled(); await Bun.sleep(1100);
  assert.equal(ticks, 1);
  assert.equal(aide.works().length, 0);
  assert.equal(aide.findConversation("timer")!.conversations.inputs().length, 0);
  const run = aide.findConversation("timer")!.conversations.runs()[0]!;
  assert.equal(run.status.phase, "done");
  const blocks = conversationView(aide, "timer").blocks;
  assert.ok(blocks.some((b) => b.type === "execution" && b.group_id === run.id));
  assert.ok(blocks.some((b) => b.type === "message" && b.group_id === run.id && b.content.includes("值得跟进")));
});

test("Timer can ask and continue in its own activation without fabricating a user Input", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-conv-trigger-ask-"));
  let aide: Aide, turns = 0;
  aide = new Aide(root, fakeOptions({ chief: async () => {
    turns++;
    if (turns === 1) {
      const store = aide.findConversation("me")!.conversations;
      const run = store.runs("me").find((r) => r.status.phase === "running")!;
      await store.updateRun(run, { question: { kind: "confirm", title: "下一步", prompt: "现在验证吗？" } });
      return "";
    }
    return "收到，暂不验证。";
  }, execute: async () => { throw new Error("No work"); } }, root), log);
  const scope = aide.session("me");
  const c = await scope.conversations.ensure();
  await scope.plugins.resourceClient("personal").replace(c, { ...c.spec, trigger: { enabled: true, intervalSeconds: 3600 } },
    { ...c.status, nextTriggerAt: new Date(0).toISOString() });
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.start(); await until(() => aide.questions().some((q) => q.request.status === "pending"));
  const q = aide.questions().find((q) => q.request.status === "pending")!;
  const view = conversationView(aide, "me");
  const run = scope.conversations.runs()[0]!;
  assert.equal(view.meta.activity?.phase, "waiting");
  assert.ok(view.blocks.some((b) => b.type === "question" && b.group_id === run.id));
  assert.equal(aide.sessions().flatMap((s) => s.conversations.inputs()).length, 0);
  const request = q.request.request;
  assert.equal(request.kind, "question");
  if (request.kind !== "question") throw new Error("Missing question");
  await scope.core.resolveInteraction({ kind: "interaction_response", messageId: q.request.messageId }, async () => ({
    kind: "question", outcome: "answered", answers: { [request.questions[0]!.questionId]: ["decline"] },
  }));
  await aide.settled();
  assert.equal(turns, 2);
  assert.equal(scope.conversations.runs()[0]!.status.phase, "done");
  assert.match(aide.messages().at(-1)!.text, /暂不验证/);
});

test("Restart coalesces due triggers, hides quiet results and does not replay interrupted activations", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-conv-trigger-recovery-"));
  const session = new SessionStore(root).createSession({ id: "quiet", cwd: root });
  const conversations = new ConversationStore(session);
  const c = await configure(conversations, "quiet", 3600, Date.now() - 86_400_000);
  await createResourceClient(conversations.resources).patchStatus(c, { processing: {
    "timer:interrupted": { phase: "running", timerAt: new Date(0).toISOString(), executionId: "old" },
  } });
  let aide: Aide, calls = 0;
  const options = fakeOptions({ chief: async () => {
    calls++;
    const store = aide.findConversation("quiet")!.conversations;
    const run = store.runs().find((r) => r.status.phase === "running")!;
    await store.updateRun(run, { quietReason: "Nothing new" });
    return "internal review";
  }, execute: async () => { throw new Error("No work"); } }, root);
  aide = new Aide(root, options, log);
  t.after(async () => { await aide.close(); await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  await aide.start(); await aide.settled();
  assert.equal(calls, 1);
  assert.equal(aide.findConversation("quiet")!.conversations.runs().find((r) => r.id === "timer:interrupted")!.status.phase, "failed");
  assert.ok(!conversationView(aide, "quiet").blocks.some((b) => b.content.includes("internal review")));
  assert.equal(aide.sessions().flatMap((s) => s.conversations.inputs()).length, 0);
  await aide.close(); aide = new Aide(root, options, log);
  await aide.start(); await aide.settled();
  assert.equal(calls, 1);
});

test("Future trigger requeues without another input; ordinary messages preserve its deadline", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-conv-trigger-future-"));
  let ticks = 0;
  const aide = new Aide(root, fakeOptions({ chief: async (prompt) => {
    if (prompt.includes('"kind":"timer"')) ticks++;
    return "收到";
  }, execute: async () => { throw new Error("No work"); } }, root), log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive({ channelId: "web", id: "first", sessionId: "me", text: "你好" }); await aide.settled();
  await aide.setConversationTrigger("me", true);
  const scope = aide.findConversation("me")!;
  const due = scope.conversations.resource("me")!.status.nextTriggerAt;
  await aide.receive({ channelId: "web", id: "second", sessionId: "me", text: "继续聊聊" }); await aide.settled();
  assert.equal(scope.conversations.resource("me")!.status.nextTriggerAt, due);
  const c = scope.conversations.resource("me")!;
  await scope.plugins.resourceClient("personal").replace(c, { ...c.spec, trigger: { enabled: true, intervalSeconds: 1 } },
    { ...c.status, nextTriggerAt: new Date(Date.now() + 200).toISOString() });
  await until(() => ticks === 2);
  await aide.setConversationTrigger("me", false); await aide.settled();
  assert.equal(scope.conversations.inputs().length, 2);
  assert.equal(scope.conversations.runs().filter((r) => r.status.timerAt).length, 2);
});
