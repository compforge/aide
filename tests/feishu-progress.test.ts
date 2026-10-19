import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import pino from "pino";
import * as Lark from "@larksuiteoapi/node-sdk";
import { Aide } from "../src/app.ts";
import type { Message } from "../plugins/personal/model.ts";
import { FeishuChannel } from "../src/channel/feishu.ts";
import { feishuProgress, progressCard, type FeishuProgress } from "../src/channel/feishu-card.ts";
import { feishuTransport, type FeishuTransport } from "../src/channel/feishu-client.ts";
import type { HarnessEventSink } from "../src/host/harness/adapter.ts";
import { fakeOptions } from "./fake-harness.ts";

const log = pino({ level: "silent" });
const conversationId = "feishu:cli_progress:oc_chat";
const event = { sender: { sender_type: "user" }, message: { message_id: "om_input", chat_id: "oc_chat", chat_type: "p2p", message_type: "text", content: '{"text":"检查工作"}' } };
const message = (id: string, text: string): Message => ({ id, text, conversationId, role: "aide", workId: null, at: new Date().toISOString() });

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-feishu-progress-"));
  const messages: Message[] = [], calls: { kind: string; args: unknown[] }[] = [];
  let view: FeishuProgress = { id: "input", phase: "queued", think: "", content: "", messageIds: [], overflow: false };
  const record = (kind: string, args: unknown[]) => { calls.push({ kind, args }); };
  const transport: FeishuTransport = { async start() {}, close() {}, async send(...args) { record("text", args); },
    cards: { async create(...args) { record("create", args); return "card-1"; }, async send(...args) { record("send", args); },
      async content(...args) { record("content", args); }, async settings(...args) { record("settings", args); }, async update(...args) { record("update", args); } } };
  const aide = { receive: async () => { throw new Error("Delivery must not execute input"); }, messages: () => messages };
  const reader = (id: string) => { assert.equal(id, conversationId); return [view]; };
  let channel = new FeishuChannel(home, "cli_progress", aide, transport, log, reader);
  channel.receive(event);
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  return { calls, messages, transport, get channel() { return channel; }, view: (next: Partial<FeishuProgress>) => { view = { ...view, ...next }; },
    async reopen() { await channel.close(); channel = new FeishuChannel(home, "cli_progress", aide, transport, log, reader); } };
}

test("Feishu streams think/content in one card, closes on question, resumes and persists final delivery", async (t) => {
  const f = setup(t);
  await f.channel.deliver();
  f.view({ phase: "running" }); await f.channel.deliver();
  assert.ok(f.calls.some((call) => call.kind === "content" && call.args[1] === "think" && call.args[2] === "正在处理"));
  f.view({ think: "检查 **工作**", content: "第一" });
  await Promise.all([f.channel.deliver(), f.channel.deliver()]);
  f.view({ content: "第一段回复" }); await f.channel.deliver();
  const contents = f.calls.filter((call) => call.kind === "content");
  assert.ok(contents.some((call) => call.args[1] === "think" && call.args[2] === "检查 **工作**"));
  assert.equal(contents.at(-1)?.args[2], "第一段回复", "Updates send accumulated text, not a token delta");
  f.messages.push(message("question", "确认继续吗？"));
  f.view({ phase: "waiting", content: "确认继续吗？", messageIds: ["question"] });
  await f.channel.deliver();
  assert.ok(f.calls.find((call) => call.kind === "settings" && call.args[1] === false));
  const card = f.calls.filter((call) => call.kind === "update").at(-1)!.args[1] as { body: { elements: { tag: string; expanded?: boolean }[] } };
  assert.equal(card.body.elements[0]?.tag, "collapsible_panel"); assert.equal(card.body.elements[0]?.expanded, false);
  assert.equal(f.calls.filter((call) => call.kind === "text").length, 0);
  const before = f.calls.length; await f.reopen(); await f.channel.deliver(); assert.equal(f.calls.length, before);
  f.view({ phase: "running", content: "继续检查", messageIds: [] }); await f.channel.deliver();
  f.messages.push(message("final", "检查完成")); f.view({ phase: "done", content: "检查完成", messageIds: ["final"] });
  await f.channel.deliver();
  assert.equal(f.calls.filter((call) => call.kind === "create").length, 1);
  assert.equal(f.calls.filter((call) => call.kind === "send").length, 1);
  assert.equal(f.calls.filter((call) => call.kind === "text").length, 0, "A finalized card replaces normal delivery of the same Message");
  const updates = f.calls.filter((call) => ["content", "settings", "update"].includes(call.kind));
  const sequences = updates.map((call) => call.args[call.kind === "content" ? 3 : 2] as number);
  assert.ok(sequences.every((value, index) => index === 0 || value > sequences[index - 1]!));
  const after = f.calls.length; await f.reopen(); await f.channel.deliver(); assert.equal(f.calls.length, after);
});

test("Feishu preserves card ID and send uuid after an ambiguous card send", async (t) => {
  const f = setup(t); const send = f.transport.cards!.send;
  let fail = true;
  f.transport.cards!.send = async (...args) => { await send(...args); if (fail) { fail = false; throw new Error("timeout after send"); } };
  await f.channel.deliver(); await f.reopen(); await f.channel.deliver();
  const sends = f.calls.filter((call) => call.kind === "send");
  assert.equal(f.calls.filter((call) => call.kind === "create").length, 1);
  assert.deepEqual(sends[0]?.args, sends[1]?.args);
});

test("Feishu card failure falls back to final text without reexecuting work", async (t) => {
  const f = setup(t); await f.channel.deliver();
  f.transport.cards!.content = async () => { throw new Error("permission or network failure"); };
  f.view({ phase: "running", think: "思考内容" }); await f.channel.deliver();
  f.messages.push(message("final", "完整结果")); f.view({ phase: "done", content: "完整结果", messageIds: ["final"] });
  await f.channel.deliver();
  assert.deepEqual(f.calls.filter((call) => call.kind === "text").map((call) => call.args[1]), ["完整结果"]);
  await f.reopen(); await f.channel.deliver();
  assert.equal(f.calls.filter((call) => call.kind === "text").length, 1);
});


test("Feishu retries the live layout when resuming a question card fails", async (t) => {
  const f = setup(t); await f.channel.deliver();
  f.view({ phase: "waiting", content: "哪个项目？" }); await f.channel.deliver();
  const update = f.transport.cards!.update;
  let fail = true;
  f.transport.cards!.update = async (...args) => { if (fail) { fail = false; throw new Error("layout update failed"); } await update(...args); };
  f.view({ phase: "running", think: "读取答复", content: "继续" }); await f.channel.deliver();
  await f.reopen(); await f.channel.deliver();
  const card = f.calls.filter((call) => call.kind === "update").at(-1)!.args[1] as { config: { streaming_mode: boolean }; body: { elements: { tag: string }[] } };
  assert.equal(card.config.streaming_mode, true);
  assert.equal(card.body.elements[0]?.tag, "markdown");
});

test("Feishu long answers retain full text via the existing split outbox", async (t) => {
  const f = setup(t); await f.channel.deliver();
  const text = "答案😀".repeat(2000);
  f.messages.push(message("long", text)); f.view({ phase: "done", content: Array.from(text).slice(0, 4000).join(""), overflow: true, messageIds: ["long"] });
  await f.channel.deliver();
  const parts = f.calls.filter((call) => call.kind === "text").map((call) => call.args[1]);
  assert.equal(parts.join(""), text); assert.equal(parts.length, 2);
});

test("Feishu projects real Harness thought and text before final reply and isolates the conversation", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-feishu-live-"));
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let emitter: { sink: HarnessEventSink; turnId: string } | undefined;
  const options = fakeOptions({ chief: async () => { await gate; return "最终答案"; }, execute: async () => { throw new Error("No Work expected"); } }, root);
  const aide = new Aide(root, { ...options, createAdapter(target) {
    const adapter = options.createAdapter(target), open = adapter.open.bind(adapter), send = adapter.sendTurn.bind(adapter);
    let sink: HarnessEventSink;
    adapter.open = async (...args) => { sink = args[1]; return open(...args); };
    adapter.sendTurn = async (ref, input) => { emitter = { sink, turnId: input.turnId }; return send(ref, input); }; return adapter;
  } }, log);
  t.after(async () => { release(); await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive({ id: "om_live", conversationId, text: "查看工作" });
  for (let i = 0; i < 200 && !emitter; i++) await Bun.sleep(10);
  assert.ok(emitter);
  emitter.sink({ kind: "agent_thought_chunk", turnId: emitter.turnId, payload: { messageId: "thought", content: { type: "text", text: "先读资料" } } });
  emitter.sink({ kind: "agent_message_chunk", turnId: emitter.turnId, payload: { messageId: "reply", content: { type: "text", text: "正在核对" } } });
  const live = feishuProgress(aide, conversationId)[0]!;
  assert.equal(live.phase, "running"); assert.equal(live.think, "先读资料"); assert.equal(live.content, "正在核对");
  assert.deepEqual(feishuProgress(aide, "me"), []);
  emitter.sink({ kind: "agent_message_chunk", turnId: emitter.turnId, payload: { messageId: "reply", content: { type: "text", text: "\u0000".repeat(4000) } } });
  const large = feishuProgress(aide, conversationId)[0]!;
  assert.ok(large.overflow);
  assert.ok(Buffer.byteLength(JSON.stringify({ type: "card_json", data: JSON.stringify(progressCard(large, false)) })) <= 28_000);
  release(); await aide.settled();
  const done = feishuProgress(aide, conversationId)[0]!;
  assert.equal(done.phase, "done"); assert.equal(done.content, "最终答案"); assert.equal(done.messageIds.length, 1);
});

test("official SDK creates, sends, streams and finalizes CardKit cards through the shared client", async (t) => {
  const original = Lark.defaultHttpInstance.defaults.adapter;
  t.after(() => { Lark.defaultHttpInstance.defaults.adapter = original; });
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  let rejectUpdate = false;
  Lark.defaultHttpInstance.defaults.adapter = async (config) => {
    assert.equal(config.timeout, 15_000);
    let data: unknown;
    if (config.url?.includes("tenant_access_token")) data = { code: 0, tenant_access_token: "fixture", expire: 7200 };
    else {
      const body = JSON.parse(config.data); calls.push({ url: config.url!, body });
      data = rejectUpdate ? { code: 99991672 } : { code: 0, data: config.url?.endsWith("/im/v1/messages") ? { message_id: "om_card" } : { card_id: "card-1" } };
    }
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  const transport = feishuTransport({ appId: "cli_card_sdk", appSecret: "fixture" }, log); t.after(() => transport.close());
  const cards = transport.cards!;
  assert.equal(await cards.create({ schema: "2.0" }), "card-1");
  await cards.send("oc_chat", "card-1", "stable-send");
  await cards.content("card-1", "think", "思考全文", 1, "seq-1");
  await cards.settings("card-1", false, 2, "seq-2");
  await cards.update("card-1", { schema: "2.0" }, 3, "seq-3");
  assert.equal(calls[0]!.body.type, "card_json");
  assert.deepEqual(JSON.parse(calls[1]!.body.content as string), { type: "card", data: { card_id: "card-1" } });
  assert.ok(calls[2]!.url.endsWith("/cardkit/v1/cards/card-1/elements/think/content"));
  assert.equal(calls[2]!.body.content, "思考全文");
  assert.deepEqual(JSON.parse(calls[3]!.body.settings as string), { config: { streaming_mode: false } });
  rejectUpdate = true;
  await assert.rejects(cards.update("card-1", {}, 4, "seq-4"), /code 99991672/);
});
