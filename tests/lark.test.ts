import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import pino from "pino";
import * as Lark from "@larksuiteoapi/node-sdk";
import { Aide } from "../src/app.ts";
import { larkAddress } from "../src/channel/address.ts";
import { LarkChannel } from "../src/channel/lark/index.ts";
import type { Incoming } from "../src/channel/message.ts";
import { larkTransport, larkSendFailure, type LarkTransport } from "../src/channel/lark/client.ts";
import { fakeOptions as baseFakeOptions } from "./fake-harness.ts";
import { LOCAL_ME } from "../plugins/personal/person/model.ts";
// These transport tests use a known Me audience; disclosure rejection has dedicated tests.
const fakeOptions = (...args: Parameters<typeof baseFakeOptions>) => ({ ...baseFakeOptions(...args),
  destinationAudience: async () => ({ identities: [LOCAL_ME], complete: true, private: true }),
  checkDisclosure: async () => ({ allowed: true, reason: "Transport fixture" }) });

const log = pino({ level: "silent" });
const event = (id: string, text: string, chatId = "oc_chat") => ({
  sender: { sender_type: "user" },
  message: { message_id: id, chat_id: chatId, chat_type: "p2p", message_type: "text", content: JSON.stringify({ text }) },
});
function fakeTransport(botIdentity?: LarkTransport["botIdentity"]) {
  const sent: { chatId: string; text: string; id: string }[] = [];
  const transport: LarkTransport = {
    botIdentity,
    async start() {}, close() {}, async chatName() { return undefined; },
    async send(chatId, text, id) { sent.push({ chatId, text, id }); },
  };
  return { transport, sent };
}

test("Lark inbox survives restart; duplicate events do not execute twice; ordinary topic does not create Work", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-"));
  let routes = 0;
  const aide = new Aide(home, fakeOptions({
    async chief(prompt) { routes++; return prompt.includes('小明') ? "你好，小明" : "怎么称呼你？"; },
    async execute() { throw new Error("No work expected"); },
  }, home, [], home, "cli_test"), log);
  const { transport, sent } = fakeTransport();
  let channel = new LarkChannel(home, "cli_test", aide, transport, log);
  t.after(async () => { await channel.close(); await aide.close(); rmSync(home, { recursive: true, force: true }); });
  channel.receive(event("om_1", "写个问候"));
  channel.receive(event("om_1", "写个问候"));
  assert.equal(routes, 0, "Event acknowledgement must not wait for Harness");
  await channel.close();
  channel = new LarkChannel(home, "cli_test", aide, transport, log);
  await channel.dispatch();
  await aide.settled();
  await channel.deliver();
  assert.equal(routes, 1);
  assert.deepEqual(sent.map((message) => message.text), ["怎么称呼你？"]);
  assert.equal(aide.works().length, 0);
  await channel.close();
  channel = new LarkChannel(home, "cli_test", aide, transport, log);
  channel.receive(event("om_1", "写个问候"));
  await channel.dispatch();
  await channel.deliver();
  assert.equal(sent.length, 1, "Restart must not resend delivered messages");
  channel.receive(event("om_2", "小明"));
  await channel.dispatch();
  await aide.settled();
  await channel.deliver();
  assert.equal(routes, 2);
  assert.equal(aide.works().length, 0);
  assert.equal(sent.at(-1)!.text, "你好，小明");
  assert.ok(sent.every((message) => message.chatId === "oc_chat"));
});

test("Lark rejects persisted inputs without an exact topic key before intake", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-key-"));
  let received = 0;
  const aide = { receive: async () => { received++; throw new Error("Unexpected intake"); } };
  const { transport } = fakeTransport();
  const channel = new LarkChannel(home, "cli_test", aide, transport, log);
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  channel.receive(event("pending", "待处理"));
  await channel.close();
  const path = join(home, "channels", readdirSync(join(home, "channels"))[0]!);
  const saved = JSON.parse(readFileSync(path, "utf8"));
  const key = saved.pending[0].topicKey;
  delete saved.pending[0].topicKey;
  for (const legacy of [false, true]) {
    if (legacy) saved.pending[0].sessionId = key;
    writeFileSync(path, JSON.stringify(saved));
    assert.throws(() => new LarkChannel(home, "cli_test", aide, transport, log), /topicKey/);
  }
  assert.equal(received, 0, "An unlocatable persisted input must never reach routing");
});

test("Lark sends explicit destinations and retries the same part id after restart", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-outbox-"));
  const aide = { receive: async () => { throw new Error("unused"); } };
  const { transport, sent } = fakeTransport();
  let channel = new LarkChannel(home, "cli_test", aide, transport, log);
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  const message = { id: "news", target: larkAddress("cli_test", "oc_chat"), text: "有变化😀".repeat(2000) };
  let calls = 0;
  transport.send = async (chatId, text, id) => {
    sent.push({ chatId, text, id });
    if (++calls === 2) throw new Error("Timeout after provider may have accepted");
  };
  await assert.rejects(channel.send({ ...message, target: larkAddress("other", "oc_chat") }));
  await assert.rejects(channel.send(message));
  assert.equal(sent.length, 2);
  await channel.close();
  channel = new LarkChannel(home, "cli_test", aide, transport, log);
  await channel.send(message);
  assert.equal(sent[1]!.id, sent[2]!.id);
  assert.notEqual(sent[0]!.id, sent[2]!.id);
  assert.equal(sent[0]!.text + sent.slice(2).map(part => part.text).join(""), message.text);
  const count = sent.length;
  await channel.send(message); assert.equal(sent.length, count);
});

test("Lark ignores unaddressed group/bot events and reports unsupported input and intake failure without automatic reexecution", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-errors-"));
  let received = 0;
  const aide = { receive: async () => { received++; throw new Error("private data"); } };
  const { transport, sent } = fakeTransport();
  const channel = new LarkChannel(home, "cli_test", aide, transport, log);
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

test("Lark malformed-event diagnostics identify invalid fields without logging message content", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-invalid-"));
  const entries: string[] = [];
  const diagnosticLog = pino({ level: "warn" }, { write(line) { entries.push(line); } });
  const { transport } = fakeTransport();
  const channel = new LarkChannel(home, "cli_invalid", {
    receive: async () => { throw new Error("Invalid events must not execute"); },
  }, transport, diagnosticLog);
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  await channel.receive({ ...event("invalid", "sensitive message body"), sender: { sender_type: null } });
  assert.equal(entries.length, 1);
  const entry = JSON.parse(entries[0]!);
  assert.deepEqual(entry.issues[0].path, ["sender", "sender_type"]);
  assert.equal(entry.issues[0].code, "invalid_type");
  assert.ok(!entries[0]!.includes("sensitive message body"));
});

test("Lark accepts exact bot mentions, strips SDK placeholders, isolates chats and deduplicates concurrent group events", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-group-"));
  const prompts: string[] = [];
  const aide = new Aide(home, fakeOptions({
    async chief(prompt) { prompts.push(prompt); return "已收到群内请求"; },
    async execute() { throw new Error("No Work expected"); },
  }, home, [], home, "cli_group"), log);
  const { transport, sent } = fakeTransport({ openId: "ou_aide", name: "Aide" });
  const lookups: string[] = [];
  transport.chatName = async chatId => { lookups.push(chatId); return chatId === "oc_group" ? "沙箱支持群" : "另一支持群"; };
  let channel = new LarkChannel(home, "cli_group", aide, transport, log);
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
  assert.deepEqual(lookups, [], "Durable receipt must precede network metadata lookup");
  await channel.close(); channel = new LarkChannel(home, "cli_group", aide, transport, log);
  await channel.receive(addressed);
  await channel.dispatch(); await aide.settled(); await channel.deliver();
  assert.equal(prompts.length, 3);
  assert.deepEqual(lookups, ["oc_group", "oc_other_group"]);
  const namedTopic = aide.topics.byKey("lark:cli_group:oc_group")!;
  assert.equal(namedTopic.spec.name, "沙箱支持群");
  assert.equal(aide.topics.get(namedTopic.spec.id)!.name, "沙箱支持群");
  assert.ok(prompts.some(prompt => prompt.includes("沙箱支持群")));
  assert.ok(prompts.some((prompt) => prompt.includes("看下 @小王 的需求")));
  assert.ok(prompts.every((prompt) => JSON.parse(prompt.split("Activation: ")[1]!.split("\n")[0]!).inputs
    .some((input: { description: string }) => input.description.includes('"assistant":{"id":"ou_aide","name":"Aide"}'))),
    "Known bot identity survives pending inbox persistence and enters model previews");
  assert.ok(prompts.every((prompt) => !prompt.includes("@_user_")));
  assert.deepEqual(new Set(sent.map((item) => item.chatId)), new Set(["oc_group", "oc_other_group", "oc_direct"]));
  assert.equal(sent.length, 3);
  assert.deepEqual(new Set(aide.outputs().map((item) => aide.topics.resource(item.topicId)!.spec.topicKey)), new Set([
    "lark:cli_group:oc_group", "lark:cli_group:oc_other_group", "lark:cli_group:oc_direct",
  ]));
  assert.equal(aide.works().length, 0);
});

test("Lark persists thread topics while cards and failure notices retain the real chat destination", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-threads-"));
  const received: Incoming[] = [], queried: string[] = [], cardChats: string[] = [];
  const { transport, sent } = fakeTransport({ openId: "ou_bot", name: "Aide" });
  let nameReads = 0;
  transport.chatName = async () => { nameReads++; return "支持群"; };
  transport.cards = {
    async create() { return "card"; }, async send(chatId) { cardChats.push(chatId); },
    async content() {}, async patch() {}, async settings() {}, async update() {},
  };
  const aide = { async receive(input: Incoming) {
    received.push(input);
    if (input.id === "failed") throw new Error("intake failed");
    return { inputId: input.id, at: new Date().toISOString() };
  } };
  const reader = (id: string) => {
    queried.push(id);
    return [{ id, phase: "queued" as const, think: "", content: "", messageIds: [], overflow: false }];
  };
  let channel = new LarkChannel(home, "cli_app", aide, transport, log, reader);
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  const group = (id: string, threadId?: string, messageType = "text") => ({
    sender: { sender_type: "user", sender_id: { open_id: id === "a2" ? "ou_another" : "ou_sender" } },
    message: { ...event(id, "@_user_1 check", "oc_group").message, chat_type: "group", thread_id: threadId,
      message_type: messageType, mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }] },
  });
  await Promise.all([channel.receive(group("a", "omt_a")), channel.receive(group("a", "omt_a"))]);
  await channel.receive(group("a2", "omt_a"));
  await channel.receive(group("plain"));
  await channel.receive(group("image", "omt_b", "image"));
  await channel.receive(group("failed", "omt_a"));
  const dm = event("dm", "hello", "oc_dm");
  await channel.receive({ ...dm, message: { ...dm.message, thread_id: "omt_ignored" } });
  await channel.close();
  channel = new LarkChannel(home, "cli_app", aide, transport, log, reader);
  await channel.dispatch(); await channel.deliver();
  assert.deepEqual(received.map(i => i.topicKey), [
    "lark:cli_app:oc_group:thread:omt_a", "lark:cli_app:oc_group:thread:omt_a",
    "lark:cli_app:oc_group", "lark:cli_app:oc_group:thread:omt_a", "lark:cli_app:oc_dm",
  ]);
  assert.equal(received[0]!.observation!.threadId, "omt_a");
  assert.equal(received[0]!.topicName, "支持群 · check");
  assert.equal(received[2]!.topicName, "支持群");
  assert.equal(nameReads, 1, "Same-chat metadata is cached independently of thread keys");
  assert.deepEqual(new Set(queried), new Set([
    "lark:cli_app:oc_group:thread:omt_a", "lark:cli_app:oc_group:thread:omt_b",
    "lark:cli_app:oc_group", "lark:cli_app:oc_dm",
  ]));
  assert.deepEqual(cardChats.sort(), ["oc_dm", "oc_group", "oc_group", "oc_group"]);
  assert.equal(sent.length, 2);
  assert.ok(sent.every(n => n.chatId === "oc_group"));
  await channel.close();
  channel = new LarkChannel(home, "cli_app", aide, transport, log, reader);
  await channel.receive(group("a", "omt_a")); await channel.dispatch(); await channel.deliver();
  assert.equal(received.length, 5); assert.equal(sent.length, 2); assert.equal(cardChats.length, 4);
});

test("Lark accepts nullable permission-restricted user IDs and still requires the bot open ID", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-null-ids-"));
  const received: { id: string; text: string }[] = [];
  const { transport } = fakeTransport({ openId: "ou_aide", name: "Aide" });
  const channel = new LarkChannel(home, "cli_null_ids", {
    receive: async (input) => {
      received.push(input);
      return { inputId: input.id, at: new Date().toISOString() };
    },
  }, transport, log);
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  // @case Live Lark group events may expose open_id while withholding user_id as null.
  const group = {
    sender: { sender_type: "user", sender_id: { open_id: "ou_sender", user_id: null } },
    message: { ...event("null-ids", "@_user_1 看下 @_user_2 的需求", "oc_group").message, chat_type: "group",
      mentions: [
        { key: "@_user_1", name: "Aide", id: { open_id: "ou_aide", user_id: null } },
        { key: "@_user_2", name: "小王", id: { open_id: "ou_wang", user_id: null } },
      ] },
  };
  await channel.receive(group);
  await channel.receive({ ...group, message: { ...group.message, message_id: "other-bot",
    mentions: [{ key: "@_user_1", name: "Aide", id: { open_id: "ou_other", user_id: null } }] } });
  await channel.receive({ ...group, message: { ...group.message, message_id: "no-open-id",
    mentions: [{ key: "@_user_1", name: "Aide", id: { user_id: null } }] } });
  await channel.receive({ ...event("direct-null-id", "单聊仍可用"), sender: group.sender });
  await channel.dispatch();
  assert.deepEqual(received.map(({ id, text }) => ({ id, text })), [
    { id: "null-ids", text: "看下 @小王 的需求" },
    { id: "direct-null-id", text: "单聊仍可用" },
  ]);
});

test("Lark leaves group mentions disabled without bot identity and handles empty or non-text mentions without executing Chief", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-group-empty-"));
  const { transport, sent } = fakeTransport();
  const aide = { receive: async () => { throw new Error("No Chief execution expected"); } };
  let channel = new LarkChannel(home, "cli_group_empty", aide, transport, log);
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  const group = { ...event("no-identity", "@_user_1"), message: { ...event("no-identity", "@_user_1").message,
    chat_type: "group", mentions: [{ key: "@_user_1", id: { open_id: "ou_aide" }, name: "Aide" }] } };
  await channel.receive(group); await channel.deliver(); assert.equal(sent.length, 0);
  await channel.close();
  channel = new LarkChannel(home, "cli_group_empty", aide,
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
  const transport = larkTransport({ appId: "cli_group_sdk", appSecret: "fixture" }, log);
  t.after(() => transport.close());
  const received: unknown[] = [];
  await transport.start(async (input) => { received.push(input); });
  assert.deepEqual(transport.botIdentity, { openId: "ou_sdk_bot", name: "SDK Bot" });
  await dispatcher.invoke({ schema: "2.0", header: { event_type: "im.message.receive_v1" }, event: event("sdk-event", "hello") }, { needCheck: false });
  assert.equal(received.length, 1);
  rejectIdentity = true;
  const fallback = larkTransport({ appId: "cli_group_sdk_failure", appSecret: "fixture" }, log);
  t.after(() => fallback.close());
  await fallback.start(async (input) => { received.push(input); });
  assert.equal(fallback.botIdentity, undefined);
  await dispatcher.invoke({ schema: "2.0", header: { event_type: "im.message.receive_v1" }, event: event("sdk-direct-fallback", "hello") }, { needCheck: false });
  assert.equal(received.length, 2);
});

test("official SDK sends bot text with a stable uuid and checks API-level failure", async (t) => {
  const original = Lark.defaultHttpInstance.defaults.adapter;
  t.after(() => { Lark.defaultHttpInstance.defaults.adapter = original; });
  let rejectSend = false;
  let direct = false;
  let sends = 0;
  Lark.defaultHttpInstance.defaults.adapter = async (config) => {
    assert.equal(config.timeout, 15_000);
    let data: unknown;
    if (config.url?.includes("tenant_access_token")) {
      data = { code: 0, tenant_access_token: "test-token", expire: 7200 };
    } else {
      assert.ok(config.url?.endsWith("/im/v1/messages"));
      assert.equal(config.params.receive_id_type, direct ? "open_id" : "chat_id");
      assert.deepEqual(JSON.parse(config.data), { receive_id: direct ? "ou_me" : "oc_test", msg_type: "text", content: JSON.stringify({ text: "你好😀" }), uuid: "test-send-id" });
      sends++;
      data = rejectSend ? { code: 99991672, msg: "scope missing" } : { code: 0, data: { message_id: "om_sent" } };
    }
    return { data, status: 200, statusText: "OK", headers: {}, config };
  };
  const transport = larkTransport({ appId: "cli_sdk_test", appSecret: "test-secret" }, log);
  t.after(() => transport.close());
  await transport.send("oc_test", "你好😀", "test-send-id");
  rejectSend = true;
  await assert.rejects(transport.send("oc_test", "你好😀", "test-send-id"), error => {
    assert.match(String(error), /code 99991672/);
    assert.equal(larkSendFailure(error).apiCode, 99991672);
    return true;
  });
  rejectSend = false; direct = true;
  await transport.send("ou_me", "你好😀", "test-send-id", "open_id");
  assert.equal(sends, 3);
});

test("Persisted Lark part receipts allow Output acknowledgement recovery without another send", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-receipt-"));
  const aide = { receive: async () => { throw new Error("unused"); } };
  const { transport, sent } = fakeTransport();
  let channel = new LarkChannel(home, "cli_test", aide, transport, log);
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  const messages = ["first", "second"].map(id => ({ id, target: larkAddress("cli_test", "oc_chat"), text: id }));
  await channel.send(messages[0]!); await channel.send(messages[1]!);
  await channel.close();
  channel = new LarkChannel(home, "cli_test", aide, transport, log);
  await channel.send(messages[0]!);
  assert.deepEqual(sent.map(m => m.text), ["first", "second"]);
});

test("Chat name lookup failures keep group intake available and never expose SDK errors", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-lark-name-failure-"));
  const received: Incoming[] = [], entries: string[] = [];
  let reads = 0;
  const { transport } = fakeTransport({ openId: "ou_bot", name: "Aide" });
  transport.chatName = async () => { reads++; throw new Error("secret credentials"); };
  const channel = new LarkChannel(home, "cli_names", {
    async receive(input) { received.push(input); return { inputId: input.id, at: new Date().toISOString() }; },
  }, transport, pino({ level: "warn" }, { write(line) { entries.push(line); } }));
  t.after(async () => { await channel.close(); rmSync(home, { recursive: true, force: true }); });
  for (const id of ["one", "two"]) {
    const incoming = event(id, "@_user_1 hello");
    await channel.receive({ ...incoming, message: { ...incoming.message, chat_type: "group",
      mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" }, name: "Aide" }] } });
  }
  await channel.dispatch();
  assert.equal(reads, 1); assert.equal(received.length, 2);
  assert.ok(received.every(input => input.topicName === undefined && input.text === "hello"));
  assert.equal(entries.length, 1);
  assert.match(entries[0]!, /chat name unavailable/);
  assert.doesNotMatch(entries[0]!, /secret credentials/);
});
