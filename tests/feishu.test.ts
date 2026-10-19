import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pino from "pino";
import * as Lark from "@larksuiteoapi/node-sdk";
import { Aide } from "../src/app.ts";
import type { Message } from "../plugins/personal/model.ts";
import { FeishuChannel } from "../src/channel/feishu.ts";
import { feishuConfig, feishuTransport, type FeishuTransport } from "../src/channel/feishu-client.ts";
import { fakeOptions } from "./fake-harness.ts";

const log = pino({ level: "silent" });
const event = (id: string, text: string, chatId = "oc_chat") => ({
  sender: { sender_type: "user" },
  message: { message_id: id, chat_id: chatId, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) },
});
function fakeTransport(botIdentity?: FeishuTransport["botIdentity"]) {
  const sent: { chatId: string; text: string; id: string }[] = [];
  const transport: FeishuTransport = {
    botIdentity,
    async start() {}, close() {},
    async send(chatId, text, id) { sent.push({ chatId, text, id }); },
  };
  return { transport, sent };
}

test("Feishu inbox survives restart; duplicate events do not execute twice; ordinary conversation does not create Work", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-feishu-"));
  let routes = 0;
  const aide = new Aide(home, fakeOptions({
    async chief(prompt) { routes++; return prompt.includes('小明') ? "你好，小明" : "怎么称呼你？"; },
    async execute() { throw new Error("No work expected"); },
  }, home), log);
  const { transport, sent } = fakeTransport();
  let channel = new FeishuChannel(home, "cli_test", aide, transport, log);
  t.after(async () => { await channel.close(); await aide.close(); rmSync(home, { recursive: true, force: true }); });
  channel.receive(event("om_1", "写个问候"));
  channel.receive(event("om_1", "写个问候"));
  assert.equal(routes, 0, "Event acknowledgement must not wait for Harness");
  await channel.close();
  channel = new FeishuChannel(home, "cli_test", aide, transport, log);
  await channel.dispatch();
  await aide.settled();
  await channel.deliver();
  assert.equal(routes, 1);
  assert.deepEqual(sent.map((message) => message.text), ["怎么称呼你？"]);
  assert.equal(aide.store.read().works.length, 0);
  await channel.close();
  channel = new FeishuChannel(home, "cli_test", aide, transport, log);
  channel.receive(event("om_1", "写个问候"));
  await channel.dispatch();
  await channel.deliver();
  assert.equal(sent.length, 1, "Restart must not resend delivered messages");
  channel.receive(event("om_2", "小明"));
  await channel.dispatch();
  await aide.settled();
  await channel.deliver();
  assert.equal(routes, 2);
  assert.equal(aide.store.read().works.length, 0);
  assert.equal(sent.at(-1)!.text, "你好，小明");
  assert.ok(sent.every((message) => message.chatId === "oc_chat"));
});

test("Feishu sends proactive output, retries the same part id after failure, and isolates apps/chats", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-feishu-outbox-"));
  const messages: Message[] = [];
  const aide = { receive: async () => { throw new Error("unused"); }, messages: () => messages };
  const { transport, sent } = fakeTransport();
  let channel = new FeishuChannel(home, "cli_test", aide, transport, log);
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  channel.receive(event("om_1", "关注变化"));
  const message = (id: string, conversationId: string, text: string): Message => ({ id, conversationId, text, role: "aide", workId: "routine", at: new Date().toISOString() });
  messages.push(message("web", "me", "不要发送"), message("other", "feishu:cli_other:oc_chat", "不要发送"),
    message("unknown", "feishu:cli_test:oc_unknown", "不要发送"),
    message("news", "feishu:cli_test:oc_chat", "有变化😀".repeat(2000)));
  let calls = 0;
  transport.send = async (chatId, text, id) => {
    sent.push({ chatId, text, id });
    if (++calls === 2) throw new Error("Timeout after provider may have accepted");
  };
  await channel.deliver();
  assert.equal(sent.length, 2);
  await channel.close();
  channel = new FeishuChannel(home, "cli_test", aide, transport, log);
  await channel.deliver();
  assert.equal(sent[1]!.id, sent[2]!.id, "Ambiguous sends must reuse Feishu uuid");
  assert.notEqual(sent[0]!.id, sent[2]!.id, "Confirmed parts must not be resent");
  assert.equal(sent[0]!.text + sent.slice(2).map((part) => part.text).join(""), messages[3]!.text);
  const count = sent.length;
  await channel.deliver();
  assert.equal(sent.length, count);
});

test("Feishu ignores unaddressed group/bot events and reports unsupported input and intake failure without automatic reexecution", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-feishu-errors-"));
  let received = 0;
  const aide = { receive: async () => { received++; throw new Error("private data"); }, messages: () => [] };
  const { transport, sent } = fakeTransport();
  const channel = new FeishuChannel(home, "cli_test", aide, transport, log);
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  const group = event("group", "ignore"); group.message.chat_type = "group";
  const bot = event("bot", "ignore"); bot.sender.sender_type = "app";
  channel.receive(group); channel.receive(bot); channel.receive({});
  const image = event("image", ""); image.message.message_type = "image";
  channel.receive(image);
  channel.receive(event("failed", "开始"));
  await channel.dispatch();
  channel.receive(event("failed", "开始"));
  await channel.dispatch();
  await channel.deliver();
  assert.equal(received, 1);
  assert.equal(sent.length, 2);
  assert.ok(sent.some((message) => message.text.includes("文字消息")));
  assert.ok(sent.some((message) => message.text.includes("处理失败")));
  assert.ok(sent.every((message) => !message.text.includes("private data")));
});

test("Feishu accepts exact bot mentions, strips SDK placeholders, isolates chats and deduplicates concurrent group events", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-feishu-group-"));
  const prompts: string[] = [];
  const aide = new Aide(home, fakeOptions({
    async chief(prompt) { prompts.push(prompt); return "已收到群内请求"; },
    async execute() { throw new Error("No Work expected"); },
  }, home), log);
  const { transport, sent } = fakeTransport({ openId: "ou_aide", name: "Aide" });
  let channel = new FeishuChannel(home, "cli_group", aide, transport, log);
  t.after(async () => { await channel.close(); await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const group = (id: string, text: string, chatId = "oc_group", mentions = [
    { key: "@_user_1", id: { open_id: "ou_aide" }, name: "Aide" },
  ]) => ({ ...event(id, text, chatId), message: { ...event(id, text, chatId).message, chat_type: "group", mentions } });
  await channel.receive(group("ordinary", "普通聊天", "oc_group", []));
  await channel.receive(group("other-bot", "@_user_1 查内存", "oc_group", [{ key: "@_user_1", id: { open_id: "ou_other" }, name: "Aide" }]));
  await channel.receive(group("all", "@_all 查内存", "oc_group", [{ key: "@_all", id: { open_id: "all" }, name: "所有人" }]));
  const bot = group("bot", "@_user_1 查内存"); bot.sender.sender_type = "app"; await channel.receive(bot);
  const addressed = group("om_group", "@_user_1 看下 @_user_2 的需求", "oc_group", [
    { key: "@_user_1", id: { open_id: "ou_aide" }, name: "Aide" },
    { key: "@_user_2", id: { open_id: "ou_wang" }, name: "小王" },
  ]);
  await Promise.all([channel.receive(addressed), channel.receive(addressed)]);
  await channel.receive(group("om_other_group", "@_user_1 检查另一个群", "oc_other_group"));
  await channel.receive(event("om_direct", "检查单聊", "oc_direct"));
  // Pending group input and its cleaned text survive restart before Chief executes it.
  await channel.close(); channel = new FeishuChannel(home, "cli_group", aide, transport, log);
  await channel.receive(addressed);
  await channel.dispatch(); await aide.settled(); await channel.deliver();
  assert.equal(prompts.length, 3);
  assert.ok(prompts.some((prompt) => prompt.includes("看下 @小王 的需求")));
  assert.ok(prompts.every((prompt) => !prompt.includes("@_user_")));
  assert.deepEqual(new Set(sent.map((item) => item.chatId)), new Set(["oc_group", "oc_other_group", "oc_direct"]));
  assert.equal(sent.length, 3);
  assert.deepEqual(new Set(aide.messages().map((item) => item.conversationId)), new Set([
    "feishu:cli_group:oc_group", "feishu:cli_group:oc_other_group", "feishu:cli_group:oc_direct",
  ]));
  assert.equal(aide.store.read().works.length, 0);
});

test("Feishu leaves group mentions disabled without bot identity and handles empty or non-text mentions without executing Chief", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-feishu-group-empty-"));
  const { transport, sent } = fakeTransport();
  const aide = { receive: async () => { throw new Error("No Chief execution expected"); }, messages: () => [] };
  let channel = new FeishuChannel(home, "cli_group_empty", aide, transport, log);
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  const group = { ...event("no-identity", "@_user_1"), message: { ...event("no-identity", "@_user_1").message,
    chat_type: "group", mentions: [{ key: "@_user_1", id: { open_id: "ou_aide" }, name: "Aide" }] } };
  await channel.receive(group); await channel.deliver(); assert.equal(sent.length, 0);
  await channel.close();
  channel = new FeishuChannel(home, "cli_group_empty", aide,
    { ...transport, botIdentity: { openId: "ou_aide", name: "Aide" } }, log);
  await channel.receive(group);
  await channel.receive({ ...group, message: { ...group.message, message_id: "image", message_type: "image", content: "{}" } });
  await channel.receive({ ...group, message: { ...group.message, message_id: "invalid-json", content: "{" } });
  await channel.dispatch(); await channel.deliver();
  assert.equal(sent.length, 3); assert.ok(sent.every((item) => item.text.includes("非空文字")));
});

test("official SDK resolves bot identity before accepting events, and keeps private reception available when identity lookup fails", async (t) => {
  const original = Lark.defaultHttpInstance.defaults.adapter;
  const originalStart = Lark.WSClient.prototype.start;
  t.after(() => { Lark.defaultHttpInstance.defaults.adapter = original; Lark.WSClient.prototype.start = originalStart; });
  let rejectIdentity = false;
  Lark.defaultHttpInstance.defaults.adapter = async (config) => {
    assert.equal(config.timeout, 15_000);
    const data = config.url?.includes("tenant_access_token") ? { code: 0, tenant_access_token: "fixture", expire: 7200 }
      : rejectIdentity ? { code: 99991672 } : { code: 0, bot: { open_id: "ou_sdk_bot", app_name: "SDK Bot" } };
    if (!config.url?.includes("tenant_access_token")) assert.ok(config.url?.endsWith("/open-apis/bot/v3/info"));
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  let dispatcher!: Lark.EventDispatcher;
  Lark.WSClient.prototype.start = async function (options) { dispatcher = options.eventDispatcher; };
  const transport = feishuTransport({ appId: "cli_group_sdk", appSecret: "fixture" }, log);
  t.after(() => transport.close());
  const received: unknown[] = [];
  await transport.start(async (input) => { received.push(input); });
  assert.deepEqual(transport.botIdentity, { openId: "ou_sdk_bot", name: "SDK Bot" });
  await dispatcher.invoke({ schema: "2.0", header: { event_type: "im.message.receive_v1" }, event: event("sdk-event", "hello") }, { needCheck: false });
  assert.equal(received.length, 1);
  rejectIdentity = true;
  const fallback = feishuTransport({ appId: "cli_group_sdk_failure", appSecret: "fixture" }, log);
  t.after(() => fallback.close());
  await fallback.start(async (input) => { received.push(input); });
  assert.equal(fallback.botIdentity, undefined);
  await dispatcher.invoke({ schema: "2.0", header: { event_type: "im.message.receive_v1" }, event: event("sdk-direct-fallback", "hello") }, { needCheck: false });
  assert.equal(received.length, 2);
});

test("Feishu is optional and incomplete credentials fail without exposing secrets", () => {
  assert.equal(feishuConfig({}), undefined);
  assert.throws(() => feishuConfig({ AIDE_FEISHU_APP_SECRET: "secret" }), /^Error: Set both/);
  assert.deepEqual(feishuConfig({ AIDE_FEISHU_APP_ID: "cli_test", AIDE_FEISHU_APP_SECRET: "secret" }), { appId: "cli_test", appSecret: "secret" });
});

test("official SDK sends bot text with a stable uuid and checks API-level failure", async (t) => {
  const original = Lark.defaultHttpInstance.defaults.adapter;
  t.after(() => { Lark.defaultHttpInstance.defaults.adapter = original; });
  let rejectSend = false;
  let sends = 0;
  Lark.defaultHttpInstance.defaults.adapter = async (config) => {
    assert.equal(config.timeout, 15_000);
    let data: unknown;
    if (config.url?.includes("tenant_access_token")) {
      data = { code: 0, tenant_access_token: "test-token", expire: 7200 };
    } else {
      assert.ok(config.url?.endsWith("/im/v1/messages"));
      assert.equal(config.params.receive_id_type, "chat_id");
      assert.deepEqual(JSON.parse(config.data), { receive_id: "oc_test", msg_type: "text", content: JSON.stringify({ text: "你好😀" }), uuid: "test-send-id" });
      sends++;
      data = rejectSend ? { code: 99991672, msg: "scope missing" } : { code: 0, data: { message_id: "om_sent" } };
    }
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  const transport = feishuTransport({ appId: "cli_sdk_test", appSecret: "test-secret" }, log);
  t.after(() => transport.close());
  await transport.send("oc_test", "你好😀", "test-send-id");
  rejectSend = true;
  await assert.rejects(transport.send("oc_test", "你好😀", "test-send-id"), /code 99991672/);
  assert.equal(sends, 2);
});
