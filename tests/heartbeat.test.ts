import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import pino from "pino";
import { SessionStore } from "../src/host/store/store.ts";
import { ConversationStore } from "../src/host/conversation/store.ts";
import { SessionHeartbeat, HeartbeatConfigSchema } from "../src/host/heartbeat.ts";
import { Aide } from "../src/app.ts";
import { httpChannel } from "../src/api/index.ts";
import { conversationView } from "../src/channel/view.ts";
import { feishuProgress } from "../src/channel/feishu-card.ts";
import { fakeOptions } from "./fake-harness.ts";

const log = pino({ level: "silent" });

test("Session heartbeat defaults off, persists its deadline, coalesces downtime, and disabling preserves queued input", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-heartbeat-"));
  const storage = new SessionStore(root);
  const session = storage.createSession({ id: "owner", cwd: root });
  const conversations = new ConversationStore(session);
  conversations.archive("private", []); conversations.archive("other", []);
  const submit = (id: string, conversationId: string) => { conversations.submit(id, { sessionId: session.id, conversationId, origin: "heartbeat", text: "review" }); };
  const heartbeat = new SessionHeartbeat(session, conversations, submit);
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  assert.deepEqual(heartbeat.config, { enabled: false, intervalSeconds: 3600 });
  for (const intervalSeconds of [0, -1, 0.5]) assert.throws(() => HeartbeatConfigSchema.parse({ intervalSeconds }));
  const start = new Date("2026-01-01T00:00:00Z");
  heartbeat.tick(start); assert.equal(conversations.inputs().length, 0);
  heartbeat.setEnabled(true, "private", start);
  // Repeated enable is idempotent, and another Conversation cannot silently retarget it.
  heartbeat.setEnabled(true, "other", new Date(start.getTime() + 100));
  assert.equal(session.meta.heartbeatState!.conversationId, "private");
  heartbeat.tick(new Date(start.getTime() + 3599_000)); assert.equal(conversations.inputs().length, 0);
  const reopened = storage.openSession(session.id);
  const restored = new SessionHeartbeat(reopened, conversations, submit);
  restored.tick(new Date(start.getTime() + 10 * 3600_000));
  assert.equal(conversations.inputs().length, 1);
  const input = conversations.inputs()[0]!;
  assert.equal(input.spec.sessionId, "owner"); assert.equal(input.spec.conversationId, "private");
  assert.equal(conversations.get("private")!.messages.length, 0); // no fabricated user message
  restored.tick(new Date(start.getTime() + 11 * 3600_000));
  assert.equal(conversations.inputs().length, 1); // pending review does not accumulate
  restored.setEnabled(false, "other");
  restored.tick(new Date(start.getTime() + 20 * 3600_000));
  assert.equal(conversations.inputs().length, 1);
  assert.equal(conversations.input(input.metadata.name)!.status.phase, undefined);
  assert.equal(storage.openSession(session.id).meta.heartbeat!.enabled, false);
  await reopened.closeLogs();
});

test("Heartbeat commits input before deadline and retries the same identity after a partial commit", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-heartbeat-commit-"));
  const storage = new SessionStore(root), session = storage.createSession({ id: "me", cwd: root });
  const conversations = new ConversationStore(session); conversations.archive("me", []);
  const identities: string[] = [];
  let fail = true;
  const heartbeat = new SessionHeartbeat(session, conversations, (id, conversationId) => {
    identities.push(id);
    conversations.submit(id, { sessionId: session.id, conversationId, origin: "heartbeat", text: "review" }, { phase: "done" });
    if (fail) { fail = false; throw new Error("host stopped before deadline commit"); }
  });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  heartbeat.setEnabled(true, "me", new Date(0));
  assert.throws(() => heartbeat.tick(new Date(3600_000)));
  heartbeat.tick(new Date(3600_000));
  assert.equal(identities[0], identities[1]); assert.equal(conversations.inputs().length, 1);
  const user = conversations.submit("user", { conversationId: "me", origin: "channel", text: "pending" });
  conversations.update(user, { phase: "waiting" });
  heartbeat.tick(new Date(7200_000)); assert.equal(identities.length, 2);
});

test("Web toggles Session heartbeat only; resumed scheduler routes Chief say and allows silent reviews", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-heartbeat-app-"));
  let quiet = false;
  const prompts: string[] = [];
  let aide: Aide;
  const options = fakeOptions({ chief: async (prompt) => {
    if (prompt.includes('"origin":"heartbeat"')) {
      if (quiet) {
        const scope = aide.findConversation("private")!;
        const input = scope.conversations.inputs().find((item) => item.status.phase === "running")!;
        scope.conversations.update(input, { quietReason: "No new information" });
        return "internal review, do not deliver";
      }
      return "MR 已合入，可以验证部署效果。";
    }
    return "你好";
  }, execute: async () => { throw new Error("No Work expected"); } }, root, prompts);
  aide = new Aide(root, options, log);
  const server = httpChannel(aide, log);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  t.after(async () => { server.closeAllConnections(); server.close(); await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive({ sessionId: "owner", conversationId: "private", id: "hello", text: "你好" });
  await aide.receive({ sessionId: "owner", conversationId: "other", id: "other", text: "另一个会话" });
  await aide.receive({ sessionId: "disabled", conversationId: "disabled", id: "third", text: "关闭的会话" });
  await aide.settled();
  const post = (data: unknown) => fetch(base + "/sessions/heartbeat", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  assert.equal((await post({ sessionId: "missing", conversationId: "private", enabled: true })).status, 404);
  assert.equal((await post({ sessionId: "owner", conversationId: "private", enabled: true, intervalSeconds: 1 })).status, 400);
  assert.equal((await post({ sessionId: "owner", conversationId: "private", enabled: true })).status, 200);
  const rows = await (await fetch(base + "/conversations")).json() as { sessionId: string; heartbeat: { enabled: boolean; intervalSeconds: number } }[];
  assert.ok(rows.filter((row) => row.sessionId === "owner").every((row) => row.heartbeat.enabled && row.heartbeat.intervalSeconds === 3600));
  assert.equal(rows.find((row) => row.sessionId === "disabled")!.heartbeat.enabled, false);
  await aide.close();
  const storage = new SessionStore(root), stored = storage.openSession("owner");
  const lane = Object.values(stored.meta.lanes).find((lane) => lane.laneId.includes("chief") && Object.keys(lane.harnessSessions).length);
  assert.ok(lane);
  stored.updateMeta({ heartbeatState: { conversationId: "private", nextAt: new Date(Date.now() - 1000).toISOString() } });
  aide = new Aide(root, options, log);
  await aide.start(); await aide.settled();
  assert.equal(aide.messages().filter((message) => message.text.includes("MR 已合入")).length, 1);
  const scope = aide.findConversation("private")!;
  const review = scope.conversations.inputs().find((input) => input.spec.origin === "heartbeat")!;
  assert.equal(review.spec.sessionId, "owner"); assert.equal(review.status.phase, "done");
  assert.equal(aide.questions().length, 0);
  assert.equal(aide.session("disabled").conversations.inputs().some((input) => input.spec.origin === "heartbeat"), false);
  assert.equal(feishuProgress(aide, "private").some((view) => view.id === review.metadata.name), false);
  const heartbeatPrompt = prompts.find((prompt) => prompt.includes('"origin":"heartbeat"'))!;
  assert.match(heartbeatPrompt, /Do not repeat suggestions/); assert.match(heartbeatPrompt, /Recent conversation/);
  quiet = true;
  const before = aide.messages().length;
  scope.heartbeat.tick(new Date(Date.now() + 3601_000)); await aide.settled();
  assert.equal(aide.messages().length, before);
  assert.ok(!conversationView(aide, "private").blocks.some((block) => block.content.includes("internal review")));
  aide.setHeartbeat("owner", "private", false);
  scope.heartbeat.tick(new Date(Date.now() + 10 * 3600_000)); await aide.settled();
  assert.equal(scope.conversations.inputs().filter((input) => input.spec.origin === "heartbeat").length, 2);
});

test("Host timer wakes enabled Sessions without another user request and stops after disabling", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-heartbeat-timer-"));
  const storage = new SessionStore(root), session = storage.createSession({ id: "timer", cwd: root });
  new ConversationStore(session).archive("timer", []);
  session.updateMeta({ heartbeat: { enabled: true, intervalSeconds: 1 },
    heartbeatState: { conversationId: "timer", nextAt: new Date(Date.now() + 500).toISOString() } });
  let ticks = 0;
  const aide = new Aide(root, fakeOptions({ chief: async () => { ticks++; return "定时回顾结果"; }, execute: async () => { throw new Error("No work"); } }, root), log);
  t.after(async () => { await aide.close(); await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  await aide.start();
  for (let i = 0; i < 60 && ticks === 0; i++) await Bun.sleep(50);
  assert.equal(ticks, 1);
  aide.setHeartbeat("timer", "timer", false);
  await aide.settled(); await Bun.sleep(1200);
  assert.equal(ticks, 1);
  assert.equal(aide.messages().filter((message) => message.role === "user").length, 0);
});
