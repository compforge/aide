import { seedInput } from "./conversation-fixture.ts";
import { completeInputs } from "../plugins/personal/conversation/complete.ts";
import { larkAddress } from "../src/channel/address.ts";
import { fixtureIncoming } from "./address-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import pino from "pino";
import * as Lark from "@larksuiteoapi/node-sdk";
import { Aide } from "../src/app.ts";
import type { OutputView } from "../src/output.ts";
import { fixtureOutput } from "./output-fixture.ts";
import { LarkChannel } from "../src/channel/lark.ts";
import { larkProgress, progressCard, cardPreviews, type LarkProgress } from "../src/channel/lark-card.ts";
import { larkTransport, type LarkTransport } from "../src/channel/lark-client.ts";
import type { HarnessEventSink } from "../src/host/harness/adapter.ts";
import { fakeOptions } from "./fake-harness.ts";

const log = pino({ level: "silent" });
const conversationId = "lark:cli_progress:oc_chat";
const event = { sender: { sender_type: "user" }, message: { message_id: "om_input", chat_id: "oc_chat", chat_type: "p2p", message_type: "text", content: '{"text":"检查工作"}' } };
const message = (id: string, text: string): OutputView => fixtureOutput({ id, text, conversationId, role: "aide", workId: null, at: new Date().toISOString() });

function cardRegions(card: ReturnType<typeof progressCard>) {
  const envelope = card.body.elements.find((element) => "elements" in element)!;
  const panels = envelope.elements.filter((element) => (element as { tag: string }).tag === "collapsible_panel");
  return { envelope, thought: panels[0] as typeof envelope, answer: panels[1] as typeof envelope };
}

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-progress-"));
  const messages: OutputView[] = [], calls: { kind: string; args: unknown[] }[] = [];
  let view: LarkProgress = { id: "input", phase: "queued", think: "", content: "", messageIds: [], overflow: false };
  const record = (kind: string, args: unknown[]) => { calls.push({ kind, args }); };
  let card!: ReturnType<typeof progressCard>;
  const patchElement = (elements: unknown[], id: string, patch: unknown): void => {
    for (const item of elements) {
      const element = item as { element_id?: string; elements?: unknown[] };
      if (element.element_id === id) Object.assign(element, patch);
      if (element.elements) patchElement(element.elements, id, patch);
    }
  };
  const transport: LarkTransport = { async start() {}, close() {}, async send(...args) { record("text", args); },
    cards: { async create(...args) { record("create", args); card = structuredClone(args[0]) as typeof card; return `card-${calls.filter((call) => call.kind === "create").length}`; }, async send(...args) { record("send", args); },
      async content(...args) { record("content", args); patchElement(card.body.elements, args[1], { content: args[2] }); },
      async patch(...args) { record("patch", args); for (const [id, value] of Object.entries(args[1])) patchElement(card.body.elements, id, value); },
      async settings(...args) { record("settings", args); card.config.streaming_mode = args[1]; },
      async update(...args) { record("update", args); card = structuredClone(args[1]) as typeof card; } } };
  const aide = { receive: async () => { throw new Error("Delivery must not execute input"); }, outputs: () => messages };
  const reader = (id: string) => { assert.equal(id, conversationId); return [view]; };
  let channel = new LarkChannel(home, "cli_progress", aide, transport, log, reader);
  channel.receive(event);
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, calls, messages, transport, get card() { return card; }, get channel() { return channel; }, view: (next: Partial<LarkProgress>) => { view = { ...view, ...next }; },
    async reopen() { await channel.close(); channel = new LarkChannel(home, "cli_progress", aide, transport, log, reader); } };
}

test("Lark finalizes a say question and uses a new card for the next Input", async (t) => {
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
  f.view({ phase: "done", content: "确认继续吗？", messageIds: ["question"] });
  await f.channel.deliver();
  assert.ok(f.calls.find((call) => call.kind === "settings" && call.args[1] === false));
  const card = f.card;
  assert.equal(cardRegions(card).thought.expanded, false); assert.equal(cardRegions(card).envelope.expanded, true);
  assert.equal(f.calls.filter((call) => call.kind === "text").length, 0);
  const before = f.calls.length; await f.reopen(); await f.channel.deliver(); assert.equal(f.calls.length, before);
  f.view({ id: "next-input", phase: "running", content: "继续检查", messageIds: [] }); await f.channel.deliver();
  f.messages.push(message("final", "检查完成")); f.view({ phase: "done", content: "检查完成", messageIds: ["final"] });
  await f.channel.deliver();
  assert.equal(f.calls.filter((call) => call.kind === "create").length, 2);
  assert.equal(f.calls.filter((call) => call.kind === "send").length, 2);
  assert.equal(f.calls.filter((call) => call.kind === "text").length, 0, "A finalized card replaces normal delivery of the same Message");
  const updates = f.calls.filter((call) => ["content", "settings", "update", "patch"].includes(call.kind));
  for (const cardId of ["card-1", "card-2"]) {
    const sequences = updates.filter((call) => call.args[0] === cardId).map((call) => call.args[call.kind === "content" ? 3 : 2] as number);
    assert.ok(sequences.every((value, index) => index === 0 || value > sequences[index - 1]!));
  }
  const after = f.calls.length; await f.reopen(); await f.channel.deliver(); assert.equal(f.calls.length, after);
});

test("Lark collapses completed long replies with a bounded preview and preserves the full delivered answer", async (t) => {
  const f = setup(t); await f.channel.deliver();
  const text = "**已建好监控，每 5 分钟检查一次。**\n\n| 项 | 值 |\n| --- | --- |\n" + "| 环境 | hf |\n".repeat(12);
  f.messages.push(message("long-table", text));
  f.view({ phase: "done", think: "已创建 Routine", content: text, messageIds: ["long-table"] });
  await f.channel.deliver();
  const card = f.card;
  const { envelope: panel, thought, answer: answerPanel } = cardRegions(card);
  assert.equal(panel.tag, "collapsible_panel"); assert.equal(panel.expanded, true);
  assert.equal(panel.header.title.tag, "plain_text");
  assert.equal(panel.header.title.content, "过程与回答");
  const preview = cardPreviews({ id: "preview", phase: "done", think: "", content: text, messageIds: [], overflow: false }).answer_preview;
  assert.equal(preview.text.tag, "plain_text"); assert.equal(preview.text.lines, 3);
  assert.ok(preview.text.content.startsWith("回答：已建好监控，每 5 分钟检查一次。 项 值 环境 hf"));
  assert.ok(!preview.text.content.includes("**"));
  assert.equal(thought.expanded, false); assert.equal(answerPanel.expanded, false);
  const body = answerPanel.elements[0] as { element_id: string; content: string };
  assert.equal(body.element_id, "content"); assert.equal(body.content, text);
  assert.equal(f.calls.filter((call) => call.kind === "text").length, 0);
  const before = f.calls.length; await f.reopen(); await f.channel.deliver(); assert.equal(f.calls.length, before);

  const unicode = cardPreviews({ id: "unicode", phase: "done", think: "", content: "😀".repeat(400), messageIds: [], overflow: false }).answer_preview;
  assert.equal(unicode.text.content, "回答：" + "😀".repeat(400), "Lark clamps visual lines without cutting Unicode");
  assert.equal(unicode.text.lines, 3);

});

test("Lark keeps stable panels with compact defaults and exposes questions and failures in the preview", () => {
  const base: LarkProgress = { id: "visible", phase: "done", think: "", content: "已完成。", messageIds: [], overflow: false };
  for (const [phase, streaming, content] of [
    ["done", false, base.content], ["done", false, "需要确认的项目\n".repeat(40)],
    ["failed", false, "处理中断\n".repeat(40)], ["running", true, "正在输出\n".repeat(40)],
  ] as const) {
    const card = progressCard({ ...base, phase, content }, streaming);
    assert.equal(card.body.elements.length, 1);
    const { envelope, thought, answer } = cardRegions(card);
    assert.equal(envelope.expanded, true);
    assert.equal(thought.expanded, false); assert.equal(answer.expanded, false);
    assert.equal(cardPreviews({ ...base, phase, content }).answer_preview.text.lines, phase === "failed" ? 1000 : 3);
    const reply = answer.elements[0] as { element_id: string; content: string };
    assert.equal(reply.element_id, "content"); assert.equal(reply.content, content);
  }
});

test("Lark previews answer text across paragraphs, lists and code without truncating at the first line", () => {
  const text = "## hf 内存\n\n当前 **1.8 GiB**，容器 `server`。\n\n- request: 2 GiB\n- limit: 4 GiB\n\n```text\n无 OOM\n```";
  const card = progressCard({ id: "preview", phase: "done", think: "查询过程", content: text, messageIds: [], overflow: false }, false);
  const preview = cardPreviews({ id: "preview", phase: "done", think: "", content: text, messageIds: [], overflow: false }).answer_preview;
  assert.deepEqual(preview.text, { tag: "plain_text", lines: 3,
    content: "回答：hf 内存 当前 1.8 GiB，容器 server。 request: 2 GiB limit: 4 GiB 无 OOM" });
  const { answer } = cardRegions(card);
  assert.equal((answer.elements[0] as { content: string }).content, text, "Expanded answer keeps its original Markdown");
});

test("Lark text updates preserve reader expansion across streaming, reconnection and completion", async (t) => {
  const f = setup(t); await f.channel.deliver();
  const { envelope, thought, answer } = cardRegions(f.card);
  thought.expanded = true; answer.expanded = true; envelope.expanded = false;
  f.view({ phase: "running", think: "当前思考", content: "正在回答" }); await f.channel.deliver();
  f.view({ content: "正在核对" }); await f.channel.deliver();
  await f.reopen();
  f.view({ phase: "running", content: "继续执行" }); await f.channel.deliver();
  f.messages.push(message("done", "最终回答"));
  f.view({ phase: "done", content: "最终回答", messageIds: ["done"] }); await f.channel.deliver();
  const current = cardRegions(f.card);
  assert.equal(current.envelope, envelope); assert.equal(current.envelope.expanded, false);
  assert.equal(current.thought.expanded, true); assert.equal(current.answer.expanded, true);
  assert.equal(f.calls.filter((call) => call.kind === "update").length, 0, "Never replace panels during normal updates");
  for (const call of f.calls.filter((call) => call.kind === "patch")) assert.ok(!JSON.stringify(call.args[1]).includes('"expanded"'));
  assert.equal((current.answer.elements[0] as { content: string }).content, "最终回答");
  const count = f.calls.length; await f.reopen(); await f.channel.deliver(); assert.equal(f.calls.length, count);
});

test("Lark preserves card ID and send uuid after an ambiguous card send", async (t) => {
  const f = setup(t); const send = f.transport.cards!.send;
  let fail = true;
  f.transport.cards!.send = async (...args) => { await send(...args); if (fail) { fail = false; throw new Error("timeout after send"); } };
  await f.channel.deliver(); await f.reopen(); await f.channel.deliver();
  const sends = f.calls.filter((call) => call.kind === "send");
  assert.equal(f.calls.filter((call) => call.kind === "create").length, 1);
  assert.deepEqual(sends[0]?.args, sends[1]?.args);
});

test("Lark card failure falls back to final text without reexecuting work", async (t) => {
  const f = setup(t); await f.channel.deliver();
  f.transport.cards!.content = async () => { throw new Error("permission or network failure"); };
  f.view({ phase: "running", think: "思考内容" }); await f.channel.deliver();
  f.messages.push(message("final", "完整结果")); f.view({ phase: "done", content: "完整结果", messageIds: ["final"] });
  await f.channel.deliver();
  assert.deepEqual(f.calls.filter((call) => call.kind === "text").map((call) => call.args[1]), ["完整结果"]);
  await f.reopen(); await f.channel.deliver();
  assert.equal(f.calls.filter((call) => call.kind === "text").length, 1);
});


test("Lark retries a failed live layout update after reconnecting", async (t) => {
  const f = setup(t); await f.channel.deliver();
  const update = f.transport.cards!.patch;
  let fail = true;
  f.transport.cards!.patch = async (...args) => { if (fail) { fail = false; throw new Error("layout update failed"); } await update(...args); };
  f.view({ phase: "running", think: "读取资料", content: "继续" }); await f.channel.deliver();
  await f.reopen(); await f.channel.deliver();
  const card = f.card;
  assert.equal(card.config.streaming_mode, true);
  assert.equal(card.body.elements[0]?.tag, "collapsible_panel");
});

test("Lark long answers retain full text via the existing split outbox", async (t) => {
  const f = setup(t); await f.channel.deliver();
  const text = "答案😀".repeat(2000);
  f.messages.push(message("long", text)); f.view({ phase: "done", content: Array.from(text).slice(0, 4000).join(""), overflow: true, messageIds: ["long"] });
  await f.channel.deliver();
  const parts = f.calls.filter((call) => call.kind === "text").map((call) => call.args[1]);
  assert.equal(parts.join(""), text); assert.equal(parts.length, 2);
});

test("Lark projects Harness progress but only explicit messages become replies", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-lark-live-"));
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
  let emitter: { sink: HarnessEventSink; turnId: string } | undefined;
  const options = fakeOptions({ chief: async () => { await gate; return "最终答案"; }, execute: async () => { throw new Error("No Work expected"); } }, root);
  const aide = new Aide(root, { ...options, createAdapter(target) {
    const adapter = options.createAdapter(target), open = adapter.open.bind(adapter), send = adapter.sendTurn.bind(adapter);
    let sink: HarnessEventSink;
    adapter.open = async (...args) => { sink = args[1]; return open(...args); };
    adapter.sendTurn = async (ref, input) => { emitter = { sink, turnId: input.invocationId }; return send(ref, input); }; return adapter;
  } }, log);
  t.after(async () => { release(); await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive(fixtureIncoming({ channelId: "lark", id: "om_live", sessionId: conversationId, conversationId, text: "查看工作" }));
  for (let i = 0; i < 200 && !emitter; i++) await Bun.sleep(10);
  assert.ok(emitter);
  emitter.sink({ kind: "agent_thought_chunk", invocationId: emitter.turnId, payload: { messageId: "thought", content: { type: "text", text: "先读资料" } } });
  emitter.sink({ kind: "agent_message_chunk", invocationId: emitter.turnId, payload: { messageId: "reply", content: { type: "text", text: "正在核对" } } });
  const live = larkProgress(aide, conversationId)[0]!;
  assert.equal(live.phase, "running"); assert.equal(live.think, "先读资料"); assert.equal(live.content, "");
  assert.deepEqual(larkProgress(aide, "me"), []);
  emitter.sink({ kind: "tool_call_update", invocationId: emitter.turnId, payload: { toolCallId: "active", title: "采集内存", status: "in_progress" } });
  emitter.sink({ kind: "tool_call_update", invocationId: emitter.turnId, payload: { toolCallId: "finished", title: "读取环境", status: "completed" } });
  assert.equal(larkProgress(aide, conversationId)[0]!.process?.tool, "采集内存 · 执行中");
  emitter.sink({ kind: "tool_call_update", invocationId: emitter.turnId, payload: { toolCallId: "active", status: "failed" } });
  assert.ok(larkProgress(aide, conversationId)[0]!.think.includes("failed"), "Tool failure remains available in details");
  emitter.sink({ kind: "agent_message_chunk", invocationId: emitter.turnId, payload: { messageId: "reply", content: { type: "text", text: "\u0000".repeat(4000) + "最新结果已到达" } } });
  const large = larkProgress(aide, conversationId)[0]!;
  assert.equal(large.content, "", "Raw model text is internal, even while streaming");
  assert.equal(large.overflow, false);
  assert.ok(Buffer.byteLength(JSON.stringify({ type: "card_json", data: JSON.stringify(progressCard(large, false)) })) <= 28_000);
  release(); await aide.settled();
  const done = larkProgress(aide, conversationId)[0]!;
  assert.equal(done.phase, "done"); assert.equal(done.content, "最终答案"); assert.equal(done.messageIds.length, 1);
  const original = aide.outputStore.get(done.messageIds[0]!)!;
  aide.outputStore.create(("sessionId" in original.metadata ? "unexpected" : undefined)!, "another-destination", { ...original.spec,
    text: "另一群的专属内容", target: larkAddress("cli_progress", "another-chat") });
  const addressed = larkProgress(aide, conversationId)[0]!;
  assert.equal(addressed.content, "最终答案");
  assert.deepEqual(addressed.messageIds, done.messageIds, "A card cannot deliver or acknowledge another destination's Output");
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
  const transport = larkTransport({ appId: "cli_card_sdk", appSecret: "fixture" }, log); t.after(() => transport.close());
  const cards = transport.cards!;
  assert.equal(await cards.create({ schema: "2.0" }), "card-1");
  await cards.send("oc_chat", "card-1", "stable-send");
  await cards.content("card-1", "think", "思考全文", 1, "seq-1");
  await cards.settings("card-1", false, 2, "seq-2");
  await cards.patch("card-1", { answer_preview: { text: { tag: "plain_text", content: "三行预览", lines: 3 } } }, 3, "seq-3");
  assert.equal(calls[0]!.body.type, "card_json");
  assert.deepEqual(JSON.parse(calls[1]!.body.content as string), { type: "card", data: { card_id: "card-1" } });
  assert.ok(calls[2]!.url.endsWith("/cardkit/v1/cards/card-1/elements/think/content"));
  assert.equal(calls[2]!.body.content, "思考全文");
  assert.deepEqual(JSON.parse(calls[3]!.body.settings as string), { config: { streaming_mode: false } });
  assert.ok(calls[4]!.url.endsWith("/cardkit/v1/cards/card-1/batch_update"));
  assert.deepEqual(JSON.parse(calls[4]!.body.actions as string), [{ action: "partial_update_element",
    params: { element_id: "answer_preview", partial_element: { text: { tag: "plain_text", content: "三行预览", lines: 3 } } } }]);
  rejectUpdate = true;
  await assert.rejects(cards.patch("card-1", {}, 4, "seq-4"), /code 99991672/);
});


test("Lark upgrades persisted legacy panels only once when execution continues", async (t) => {
  const f = setup(t); await f.channel.deliver(); await f.channel.close();
  const path = join(f.home, "channels", readdirSync(join(f.home, "channels"))[0]!);
  const state = JSON.parse(readFileSync(path, "utf8"));
  delete state.cards.input.layout; delete state.cards.input.previews;
  writeFileSync(path, JSON.stringify(state));
  await f.reopen();
  f.view({ phase: "running", think: "继续处理" }); await f.channel.deliver();
  assert.equal(f.calls.filter((call) => call.kind === "update").length, 1);
  f.view({ think: "新进展" }); await f.channel.deliver();
  assert.equal(f.calls.filter((call) => call.kind === "update").length, 1);
  assert.equal(f.calls.filter((call) => call.kind === "send").length, 1);
});


/** @case One native invocation can acknowledge inputs incrementally without closing its IM card early. */
test("Lark keeps a shared invocation card running until steered input and execution settle", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-steer-card-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No work"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const spec = { conversationId, origin: "channel" as const, originId: "lark", source: larkAddress("cli_progress", "oc_chat"), text: "request" };
  await seedInput(aide.conversations, "first", spec, { phase: "done", executionId: "live" });
  await seedInput(aide.conversations, "urgent", spec, { phase: "running", executionId: "live" });
  assert.equal(larkProgress(aide, conversationId).length, 1);
  assert.equal(larkProgress(aide, conversationId)[0]!.phase, "running");
  const client = aide.runtime.plugins.resourceClient("personal");
  await completeInputs(client, aide.conversations.resource(conversationId)!, "live", { inputIds: ["urgent"], summary: "Handled" });
  assert.equal(larkProgress(aide, conversationId)[0]!.phase, "running");
  await client.patchStatus(aide.conversations.resource(conversationId)!, { execution: null });
  assert.equal(larkProgress(aide, conversationId)[0]!.phase, "done");
});
