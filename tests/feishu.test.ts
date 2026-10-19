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
function fakeTransport() {
  const sent: { chatId: string; text: string; id: string }[] = [];
  const transport: FeishuTransport = {
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

test("Feishu ignores group/bot events and reports unsupported input and intake failure without automatic reexecution", async (t) => {
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
