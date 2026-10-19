import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pino from "pino";
import { decodeSse, PatchEmitter, applyPatch, type PatchEvent } from "@compforge/agentue/ui";
import { Aide } from "../src/app.ts";
import { chiefTarget } from "../plugins/personal/chief-model.ts";
import { httpChannel } from "../src/api/index.ts";
import { conversationView, type ConversationView } from "../src/channel/view.ts";
import { conversationPatches } from "../src/api/stream.ts";
import type { HarnessEventSink } from "../src/host/harness/adapter.ts";
import { fakeOptions } from "./fake-harness.ts";

async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await Bun.sleep(10); }
  assert.fail("Timed out waiting for web progress");
}

test("Web receives scoped progress before final reply, reconnects with a snapshot, and never delivers progress as messages", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-web-progress-"));
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const emitters = new Map<string, { sink: HarnessEventSink; turnId: string }>();
  const options = fakeOptions({ async chief() { await gate; return "最终答复"; }, async execute() { throw new Error("Unexpected Work"); } }, root);
  const log = pino({ level: "silent" });
  const aide = new Aide(root, { ...options, createAdapter(target) {
    const adapter = options.createAdapter(target);
    const open = adapter.open.bind(adapter), send = adapter.sendTurn.bind(adapter);
    let sink: HarnessEventSink;
    adapter.open = async (...args) => { sink = args[1]; return open(...args); };
    adapter.sendTurn = async (ref, input) => { emitters.set(target.id, { sink, turnId: input.turnId }); return send(ref, input); };
    return adapter;
  } }, log);
  const server = httpChannel(aide, log);
  const connections: AbortController[] = [];
  t.after(async () => {
    for (const connection of connections) connection.abort();
    release(); await aide.close(); server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const page = await fetch(base);
  assert.match(page.headers.get("content-security-policy")!, /script-src 'self'/);
  assert.match(await page.text(), /src="\/app.js"/);
  const bundle = await fetch(base + "/agentue.js");
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get("content-type")!, /javascript/);
  const browserSdk = await import(`data:text/javascript;base64,${Buffer.from(await bundle.text()).toString("base64")}`) as typeof import("../src/web/sdk.ts");
  assert.match(browserSdk.renderMarkdown("## 网页回复\n\n- **已完成**"), /<h2>网页回复<\/h2>[\s\S]*<strong>已完成<\/strong>/);
  assert.doesNotMatch(browserSdk.renderMarkdown('<script>alert(1)</script>'), /<script>/);
  async function connect(conversationId: string) {
    const controller = new AbortController(); connections.push(controller);
    const response = await fetch(`${base}/stream?conversationId=${conversationId}`, { signal: controller.signal });
    assert.match(response.headers.get("content-type")!, /text\/event-stream/);
    const views: ConversationView[] = [];
    const events: PatchEvent[] = [];
    let snapshot = {};
    const reader = response.body!.getReader();
    const reading = (async () => {
      let buffer = ""; const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read(); if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const { event } = decodeSse(frame);
          events.push(event);
          snapshot = browserSdk.applyPatch(snapshot, event);
          views.push(structuredClone(snapshot) as ConversationView);
        }
      }
    })().catch((error) => { if (!controller.signal.aborted) throw error; });
    return { views, events, close: async () => { controller.abort(); await reading; } };
  }
  assert.equal((await fetch(base + "/stream")).status, 400);
  assert.equal((await fetch(base + "/stream?conversationId=a", { headers: { origin: "https://foreign.test" } })).status, 403);
  const first = await connect("a");
  await until(() => first.views.length > 0);
  assert.equal(first.events[0]!.op, "start");
  assert.deepEqual(first.views[0], { version: "1.0", biz: "aide.conversation", blocks: [], meta: { conversation_id: "a", activity: null } });
  await aide.receive({ id: "a1", sessionId: "a", conversationId: "a", text: "查看资料" });
  await aide.receive({ id: "b1", sessionId: "b", conversationId: "b", text: "另一会话的私有内容" });
  await until(() => emitters.has(chiefTarget("a")) && emitters.has(chiefTarget("b")));
  const { sink, turnId } = emitters.get(chiefTarget("a"))!;
  const other = emitters.get(chiefTarget("b"))!;
  other.sink({ kind: "agent_thought_chunk", turnId: other.turnId, payload: { messageId: "thought-b", content: { type: "text", text: "另一会话的思考" } } });
  sink({ kind: "agent_thought_chunk", turnId, payload: { messageId: "thought-a", content: { type: "text", text: "先检查资料" } } });
  sink({ kind: "tool_call_update", turnId, payload: { toolCallId: "read-a", title: "read", status: "in_progress", rawInput: { path: "/tmp/README" } } });
  sink({ kind: "agent_message_chunk", turnId, payload: { messageId: "text-a", content: { type: "text", text: "正在整理" } } });
  await until(() => first.views.some((view) => view.blocks.some((block) => block.content === "正在整理")));
  const progress = first.views.at(-1)!;
  assert.equal(progress.blocks.filter((block) => block.parent_id).length, 3);
  assert.equal(progress.blocks.find((block) => block.type === "execution")!.status, "running");
  assert.equal(progress.blocks.find((block) => block.type === "tool")!.detail, "/tmp/README");
  assert.doesNotMatch(JSON.stringify(progress), /另一会话/);
  assert.equal(aide.messages().filter((message) => message.role === "aide").length, 0);
  sink({ kind: "agent_message_chunk", turnId, payload: { messageId: "text-a", content: { type: "text", text: "重点" } } });
  await until(() => first.events.some((event) => event.op === "append"));
  assert.equal(first.views.at(-1)!.blocks.at(-1)!.content, "正在整理重点");
  await first.close();
  sink({ kind: "agent_message_chunk", turnId, payload: { messageId: "text-a", content: { type: "text", text: "，请稍候" } } });
  const second = await connect("a");
  await until(() => second.views.length > 0);
  assert.equal(second.events[0]!.op, "start");
  assert.equal(second.views[0]!.blocks.at(-1)!.content, "正在整理重点，请稍候");
  release(); await aide.settled();
  await until(() => second.views.at(-1)?.meta.activity === null && second.views.at(-1)!.blocks.filter((block) => block.type === "message").length === 2);
  assert.equal(second.views.at(-1)!.blocks.filter((block) => block.role === "aide").length, 1);
  assert.equal(second.views.at(-1)!.blocks.filter((block) => block.type === "message").at(-1)!.content, "最终答复");
  const completed = second.views.at(-1)!;
  assert.equal(completed.blocks.find((block) => block.type === "execution")!.status, "completed");
  const groupId = completed.blocks.find((block) => block.type === "execution")!.group_id;
  assert.ok(groupId, "Execution grouping must use durable Input ownership");
  assert.equal(completed.blocks.find((block) => block.role === "aide")!.group_id, groupId);
  assert.equal(completed.blocks.find((block) => block.role === "user")!.group_id, undefined);
  assert.equal(completed.blocks.find((block) => block.type === "thought")!.content, "先检查资料");
  assert.equal(completed.blocks.find((block) => block.type === "tool")!.detail, "/tmp/README");
  assert.doesNotMatch(JSON.stringify(completed), /另一会话/);
  const refreshed = await connect("a");
  await until(() => refreshed.views.length > 0);
  assert.deepEqual(refreshed.views[0], completed);
  await refreshed.close();
  assert.equal(aide.works().length, 0);
  const messages = aide.messages.bind(aide);
  aide.messages = () => { throw new Error("projection unavailable"); };
  try {
    await until(() => second.events.at(-1)?.op === "end");
    assert.deepEqual(second.events.slice(-2).map((event) => event.op), ["error", "end"]);
    assert.equal(second.views.at(-1)!.meta.error!.code, "view_failed");
    assert.equal((await fetch(base + "/stream?conversationId=a")).status, 500);
  } finally { aide.messages = messages; }
  await second.close();
  await aide.receive({ id: "a2", sessionId: "a", conversationId: "a", text: "再聊一个问题" });
  await aide.settled();
  const later = conversationView(aide, "a");
  assert.equal(later.blocks.filter((block) => block.type === "execution").length, 2);
  assert.equal(new Set(later.blocks.filter((block) => block.type === "execution").map((block) => block.group_id)).size, 2);
  for (const reply of later.blocks.filter((block) => block.role === "aide")) {
    assert.ok(later.blocks.some((block) => block.type === "execution" && block.group_id === reply.group_id));
  }
  assert.equal(later.blocks.find((block) => block.type === "thought")!.parent_id,
    completed.blocks.find((block) => block.type === "execution")!.id);
  await aide.close();
  const reopened = new Aide(root, options, log);
  try {
    assert.deepEqual(conversationView(reopened, "a"), later);
    assert.doesNotMatch(JSON.stringify(conversationView(reopened, "a")), /另一会话/);
  } finally { await reopened.close(); }
});

test("AgentUE reducer reconstructs growing, corrected and removed progress without duplicated text", () => {
  const emitter = new PatchEmitter();
  const initial: ConversationView = { version: "1.0", biz: "aide.conversation", meta: { conversation_id: "a", activity: null },
    blocks: [{ id: "output:answer", type: "text", content: "整理" }] };
  let previous: ConversationView | undefined;
  let snapshot = {};
  for (const next of [initial,
    { ...initial, blocks: [{ id: "output:answer", type: "text" as const, content: "整理重点" }] },
    { ...initial, blocks: [{ id: "output:answer", type: "text" as const, content: "已完成" }] },
    { ...initial, blocks: [] }]) {
    for (const event of conversationPatches(emitter, previous, next)) snapshot = applyPatch(snapshot, event);
    assert.deepEqual(snapshot, next);
    previous = next;
  }
});


test("Web associates failed replies with their Input so interruption warnings remain visible", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-web-failed-reply-"));
  const aide = new Aide(root, fakeOptions({
    chief: async () => { throw new Error("controlled model failure"); },
    execute: async () => { throw new Error("No Work expected"); },
  }, root), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive({ id: "failed-reply", conversationId: "failed", text: "检查展示故障" });
  await aide.settled();
  const view = conversationView(aide, "failed");
  const reply = view.blocks.find((block) => block.role === "aide")!;
  assert.equal(reply.status, "failed");
  assert.equal(reply.group_id, aide.conversations.inputs("failed")[0]!.metadata.name);
  assert.ok(aide.invocations().some((invocation) => invocation.inputId === reply.group_id));
  assert.match(reply.content, /未完成/);
});
