import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pino from "pino";
import { decodeSse, PatchEmitter, applyPatch, type PatchEvent } from "@compforge/agentue/ui";
import { Aide } from "../plugins/personal/aide.ts";
import { chiefTarget } from "../plugins/personal/chief-model.ts";
import { httpChannel } from "../src/channel/http.ts";
import type { ConversationView } from "../src/channel/view.ts";
import { conversationPatches } from "../src/channel/stream.ts";
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
  assert.match(await page.text(), /import .* from '\/agentue.js'/);
  const bundle = await fetch(base + "/agentue.js");
  assert.equal(bundle.status, 200);
  assert.match(bundle.headers.get("content-type")!, /javascript/);
  const browserSdk = await import(`data:text/javascript;base64,${Buffer.from(await bundle.text()).toString("base64")}`) as typeof import("@compforge/agentue/ui");
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
  await aide.receive({ id: "a1", conversationId: "a", text: "查看资料" });
  await aide.receive({ id: "b1", conversationId: "b", text: "另一会话的私有内容" });
  await until(() => emitters.has(chiefTarget("a")) && emitters.has(chiefTarget("b")));
  const { sink, turnId } = emitters.get(chiefTarget("a"))!;
  sink({ kind: "agent_thought_chunk", turnId, payload: { messageId: "thought-a", content: { type: "text", text: "先检查资料" } } });
  sink({ kind: "tool_call_update", turnId, payload: { toolCallId: "read-a", title: "read", status: "in_progress", rawInput: { path: "/tmp/README" } } });
  sink({ kind: "agent_message_chunk", turnId, payload: { messageId: "text-a", content: { type: "text", text: "正在整理" } } });
  await until(() => first.views.some((view) => view.blocks.some((block) => block.content === "正在整理")));
  const progress = first.views.at(-1)!;
  assert.equal(progress.blocks.filter((block) => block.type !== "message").length, 3);
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
  await until(() => second.views.at(-1)?.meta.activity === null && second.views.at(-1)!.blocks.length === 2);
  assert.equal(second.views.at(-1)!.blocks.filter((block) => block.role === "aide").length, 1);
  assert.equal(second.views.at(-1)!.blocks.at(-1)!.content, "最终答复");
  assert.equal(aide.store.read().works.length, 0);
  const messages = aide.messages.bind(aide);
  aide.messages = () => { throw new Error("projection unavailable"); };
  try {
    await until(() => second.events.at(-1)?.op === "end");
    assert.deepEqual(second.events.slice(-2).map((event) => event.op), ["error", "end"]);
    assert.equal(second.views.at(-1)!.meta.error!.code, "view_failed");
    assert.equal((await fetch(base + "/stream?conversationId=a")).status, 500);
  } finally { aide.messages = messages; }
  await second.close();
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
