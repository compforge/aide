import { mailReader } from "./stream-fixture.ts";
import { mailView } from "../plugins/personal/stream/writer.ts";
import { fixtureCanSpeak, allowAddress, fixtureIncoming } from "./address-fixture.ts";
import { Addresses } from "../plugins/personal/address/service.ts";
import { addressRef } from "../plugins/personal/address/model.ts";
import { transportFixture } from "./output-fixture.ts";
import { larkAddress, larkThreadAddress } from "../src/channel/address.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import pino from "pino";
import * as Lark from "@larksuiteoapi/node-sdk";
import { Aide } from "../src/app.ts";
import { LarkChannel } from "../src/channel/lark/index.ts";
import { progressCard, cardPreviews } from "../src/channel/lark/card.ts";
import { larkTransport, type LarkTransport } from "../src/channel/lark/client.ts";
import type { HarnessEventSink } from "../src/host/harness/adapter.ts";
import { fakeOptions } from "./fake-harness.ts";
import type { StreamReader } from "@compforge/aide-plugin";

const log = pino({ level: "silent" });
const topicId = "lark:cli_progress:oc_chat";
function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-stream-"));
  const target = larkThreadAddress("cli_progress", "oc_chat", "request");
  allowAddress(home, target);
  const calls: { kind: string; args: unknown[] }[] = [];
  const record = (kind: string, args: unknown[]) => { calls.push({ kind, args }); };
  let card!: ReturnType<typeof progressCard>;
  const patch = (items: unknown[], id: string, value: unknown): void => {
    for (const item of items) {
      const element = item as { element_id?: string; elements?: unknown[] };
      if (element.element_id === id) Object.assign(element, value);
      if (element.elements) patch(element.elements, id, value);
    }
  };
  const transport: LarkTransport = { async start() {}, close() {}, async chatName() { return undefined; }, async send(...args) { record("text", args); },
    cards: { async create(...args) { record("create", args); card = structuredClone(args[0]) as typeof card; return "card"; }, async send(...args) { record("send", args); },
      async content(...args) { record("content", args); patch(card.body.elements, args[1], { content: args[2] }); },
      async patch(...args) { record("patch", args); for (const [id, value] of Object.entries(args[1])) patch(card.body.elements, id, value); },
      async settings(...args) { record("settings", args); card.config.streaming_mode = args[1]; },
      async update(...args) { record("update", args); card = structuredClone(args[1]) as typeof card; } } };
  const aide = { canSpeak: fixtureCanSpeak(home), async receive() { throw new Error("No intake expected"); } };
  let channel = new LarkChannel(home, "cli_progress", aide, transport, log);
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  const send = (stream: StreamReader, id = "output") => channel.send({ id, target, stream });
  return { home, target, calls, transport, send, get card() { return card; }, get channel() { return channel; },
    async reopen() { await channel.close(); channel = new LarkChannel(home, "cli_progress", aide, transport, log); } };
}
const open = (lastSeq: number, think = "", text = ""): StreamReader => mailReader("open", lastSeq, think, text);
const completed = (lastSeq: number, think = "", text = ""): StreamReader => mailReader("completed", lastSeq, think, text);
const until = async (check: () => boolean) => { for (let n = 0; n < 400 && !check(); n++) await Bun.sleep(10); assert(check()); };

test("Lark sends one checked stream card, preserves reply coordinates and finalizes before returning a receipt", async t => {
  const f = setup(t);
  await f.send(open(1, "检查中"));
  await f.send(open(2, "检查中", "第一"));
  const receipt = await f.send(completed(3, "检查完成", "第一段回答"));
  assert.deepEqual(receipt, { id: "card", scope: "cli_progress" });
  assert.equal(f.calls.filter(c => c.kind === "send").length, 1);
  assert.deepEqual(f.calls.find(c => c.kind === "send")!.args.slice(3), ["chat_id", "request"]);
  assert.equal(f.card.config.streaming_mode, false);
  const serialized = JSON.stringify(f.card);
  assert(serialized.includes("检查完成")); assert(serialized.includes("第一段回答"));
  assert.equal(f.calls.filter(c => c.kind === "text").length, 0);
  const before = f.calls.length;
  await f.reopen(); await f.send(completed(3, "检查完成", "第一段回答"));
  assert.equal(f.calls.length, before, "Restart reuses the durable card and final signature");
  const seq = f.calls.filter(c => ["content", "settings", "patch"].includes(c.kind)).map(c => Number(c.args[c.kind === "content" ? 3 : 2]));
  assert(seq.every((value, index) => !index || value > seq[index - 1]!));
});

test("Reader expansion survives stream updates and completion", async t => {
  const f = setup(t); await f.send(open(1, "思考"));
  const panels = f.card.body.elements[0]!.elements.filter(item => (item as { tag: string }).tag === "collapsible_panel") as Array<{ expanded: boolean }>;
  panels[0]!.expanded = true; panels[1]!.expanded = true;
  await f.send(open(2, "继续思考", "回答")); await f.send(completed(2, "继续思考", "回答"));
  assert(panels.every(panel => panel.expanded));
  assert.equal(f.calls.filter(c => c.kind === "update").length, 0);
});

test("Failed card update is surfaced for Output retry and resumes on the same card", async t => {
  const f = setup(t); await f.send(open(1, "思考"));
  const update = f.transport.cards!.content;
  f.transport.cards!.content = async () => { throw new Error("network failure"); };
  await assert.rejects(f.send(open(2, "新进展")));
  f.transport.cards!.content = update;
  await f.reopen(); await f.send(open(2, "新进展"));
  assert.equal(f.calls.filter(c => c.kind === "send").length, 1);
  assert(JSON.stringify(f.card).includes("新进展"));
});

test("Long stream answers retain their complete tail through idempotent text parts", async t => {
  const f = setup(t), text = "答案😀".repeat(3000);
  await f.send(completed(1, "", text));
  const tail = f.calls.filter(c => c.kind === "text").map(c => String(c.args[1])).join("");
  const panels = f.card.body.elements[0]!.elements as Array<{ elements?: Array<{ element_id?: string; content?: string }> }>;
  const prefix = panels.flatMap(p => p.elements ?? []).find(e => e.element_id === "content")!.content!.split("\n\n（内容较长")[0]!;
  assert.equal(prefix + tail, text);
  const count = f.calls.length; await f.reopen(); await f.send(completed(1, "", text));
  assert.equal(f.calls.length, count);
});

test("A mute arriving during awaited card creation prevents acknowledgement", async t => {
  const f = setup(t), places = new Addresses(f.home), place = places.observe(f.target);
  const create = f.transport.cards!.create;
  f.transport.cards!.create = async (...args) => { const card = await create(...args); places.setMuted(addressRef(place), true, false); return card; };
  await assert.rejects(f.send(open(1, "not permitted")));
  assert.equal(f.calls.filter(c => c.kind === "send").length, 0);
});

test("Chief publishes think and text before completion, without duplicating the final Harness snapshot", { timeout: 20_000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-chief-stream-"));
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let emitter: { sink: HarnessEventSink; turnId: string } | undefined;
  const options = fakeOptions({ async chief() { await gate; return "最终答案"; }, async execute() { throw new Error("No Work expected"); } }, home, [], home, "cli_progress");
  const aide = new Aide(home, { ...options, createAdapter(target) {
    const adapter = options.createAdapter(target), create = adapter.create.bind(adapter), prompt = adapter.prompt.bind(adapter);
    let sink: HarnessEventSink;
    adapter.create = async (...args) => { sink = args[1]; return create(...args); };
    adapter.prompt = async (ref, input) => { if (target.harness === "chief") emitter = { sink, turnId: input.invocationId }; return prompt(ref, input); }; return adapter;
  } }, log);
  t.after(async () => { release(); await aide.close(); rmSync(home, { recursive: true, force: true }); });
  transportFixture(aide);
  await aide.receive(fixtureIncoming({ channelId: "lark", id: "live", topicId, source: larkThreadAddress("cli_progress", "oc_chat", "live"), text: "查看工作" }));
  await until(() => !!emitter);
  assert.equal(aide.outputStore.list().length, 1, "Output exists before the first token");
  emitter!.sink({ kind: "agent_thought_chunk", invocationId: emitter!.turnId, payload: { messageId: "thought", content: { type: "text", text: "先读资料" } } });
  emitter!.sink({ kind: "agent_thought", invocationId: emitter!.turnId, payload: { messageId: "thought", content: [{ type: "text", text: "先读资料，再核对" }] } });
  emitter!.sink({ kind: "agent_message_chunk", invocationId: emitter!.turnId, payload: { messageId: "reply", content: { type: "text", text: "正在核对" } } });
  const output = aide.outputStore.list()[0]!;
  await until(() => mailView(aide.outputStore, output).text === "正在核对");
  assert.equal(mailView(aide.outputStore, output).think, "先读资料，再核对");
  assert.equal(mailView(aide.outputStore, output).phase, "open");
  emitter!.sink({ kind: "agent_message", invocationId: emitter!.turnId, payload: { messageId: "reply", content: [{ type: "text", text: "进展已修正" }] } });
  release(); await aide.settled();
  assert.equal(aide.outputStore.list().length, 1);
  assert.equal(mailView(aide.outputStore, output).phase, "completed");
  assert.equal(mailView(aide.outputStore, output).text, "进展已修正\n\n最终答案");
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


test("Lark chat names use the existing SDK client and timeout", async t => {
  const original = Lark.defaultHttpInstance.defaults.adapter;
  t.after(() => { Lark.defaultHttpInstance.defaults.adapter = original; });
  let code = 0;
  const requests: string[] = [];
  Lark.defaultHttpInstance.defaults.adapter = async config => {
    assert.equal(config.timeout, 15_000);
    const data = config.url?.includes("tenant_access_token") ? { code: 0, tenant_access_token: "fixture", expire: 7200 }
      : (requests.push(config.url!), { code, data: { name: "沙箱支持群" } });
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  const transport = larkTransport({ appId: "cli_names_sdk", appSecret: "fixture" }, log);
  t.after(() => transport.close());
  assert.equal(await transport.chatName("oc_group"), "沙箱支持群");
  assert.ok(requests[0]!.endsWith("/im/v1/chats/oc_group"));
  code = 99991672;
  await assert.rejects(transport.chatName("oc_group"), /99991672/);
});


test("Card serialization budget includes escaped content without losing the answer tail", async t => {
  const f = setup(t), text = "\0\\\"".repeat(4000);
  await f.send(completed(1, "\0".repeat(4000), text));
  const payload = f.calls.find(c => c.kind === "create")!.args[0];
  assert(Buffer.byteLength(JSON.stringify({ type: "card_json", data: JSON.stringify(payload) })) <= 28_000);
  const panels = f.card.body.elements[0]!.elements as Array<{ elements?: Array<{ element_id?: string; content?: string }> }>;
  const rendered = panels.flatMap(p => p.elements ?? []).find(e => e.element_id === "content")!.content!;
  const prefix = rendered.split("\n\n（内容较长")[0]!;
  const tail = f.calls.filter(c => c.kind === "text").map(c => String(c.args[1])).join("");
  assert.equal(prefix + tail, text);
});


test("Lark renders tool updates from the selected mail and retains them at completion", async t => {
  const f = setup(t), initial = mailReader("open", 1, "正在核对"), records = initial.read();
  records.push({ seq: 3, kind: "tool_call_update", payload: { toolCallId: "read", title: "读取资料", status: "in_progress", content: [{ type: "text", text: "发现证据" }] } });
  await f.send({ ...initial, status: { ...initial.status, lastSeq: 3 }, read: after => records.filter(r => r.seq > (after ?? 0)) });
  assert.match(JSON.stringify(f.card), /读取资料/); assert.match(JSON.stringify(f.card), /执行中/);
  const end = [...records, { seq: 4, kind: "tool_call_update", payload: { toolCallId: "read", status: "completed" } }];
  await f.send({ ...initial, status: { ...initial.status, phase: "completed", lastSeq: 4, closedAt: new Date().toISOString() }, read: after => end.filter(r => r.seq > (after ?? 0)) });
  assert.match(JSON.stringify(f.card), /发现证据/); assert.match(JSON.stringify(f.card), /已完成/);
  assert.equal(f.calls.filter(c => c.kind === "send").length, 1);
});
