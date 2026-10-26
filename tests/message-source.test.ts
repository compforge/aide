import { OutputStore } from "../plugins/personal/output/store.ts";
import personalDefinitions from "../plugins/personal/definitions.ts";
import { openPersonCatalog } from "../plugins/personal/person/catalog.ts";
import { fixtureAddress } from "./address-fixture.ts";
import { fixtureIncoming } from "./address-fixture.ts";
import { SOURCES } from "../plugins/personal/source/definition.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { ChatMessage, MessagePage, MessageSearchQuery, PluginLogger } from "@compforge/aide-plugin";
import { HarnessFixtures } from "./harness-fixture.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { personalAdmission } from "../plugins/personal/admission.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { emptyConnectors } from "../src/connector-client.ts";
import { MESSAGE_SOURCE_TYPE, observeMessages, type MessageSourceStatus } from "../plugins/personal/source/message/observe.ts";
import { messageWatch, MessageWatchSchema, MESSAGE_SESSION, type MessageKind, type MessageWatch } from "../plugins/personal/source/message/config.ts";
import { readMessageContext } from "../plugins/personal/source/message/context.ts";
import { Aide } from "../src/app.ts";
import { LarkChannel } from "../src/channel/lark/index.ts";
import { larkProgress } from "../src/channel/lark/card.ts";
import { loadConfig } from "../src/config.ts";
import { fakeOptions } from "./fake-harness.ts";
import { messageRelation } from "../plugins/personal/source/message/relation.ts";
import { inputPreview } from "../plugins/personal/input/prompt.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const now = Date.parse("2026-10-20T08:00:00Z");
const message = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id, chatId: "oc_chat", sender: { id: "ou_other", type: "user" }, content: id,
  createdAt: new Date(now - 60_000).toISOString(), deleted: false, mentions: ["ou_me"], ...patch,
});
const page = (messages: ChatMessage[], extra: Partial<MessagePage> = {}): MessagePage =>
  ({ messages, hasMore: false, observedThrough: new Date(now).toISOString(), ...extra });
const person = { identities: [{ provider: "lark", scope: "cli_app", id: "ou_me" }] };
const watch = (patch: Partial<MessageWatch> = {}) => ({ ...messageWatch(MessageWatchSchema.parse({}), { appId: "cli_app", userId: "ou_me" }, person)!, ...patch });

function fixture(t: TestContext, spec = watch(), discoveryKind?: MessageKind) {
  const root = mkdtempSync(join(tmpdir(), "aide-message-source-"));
  const sessions = new HarnessFixtures(root); const session = sessions.create({ id: MESSAGE_SESSION, cwd: root });
  const inputs = new InputStore(root);
  let store = new PluginResourceStore({ home: session.home, pluginInstanceId: "personal" });
  store.storage.register("personal", personalDefinitions);
  const catalog = openPersonCatalog(root, person, pino({ level: "silent" }), () => {});
  const client = (session: import("./harness-fixture.ts").HarnessFixture) => createResourceClient(store, undefined, undefined, personalAdmission(inputs, new OutputStore(session.home)));
  let resources = client(session);
  store.create({ type: MESSAGE_SOURCE_TYPE, name: "messages", spec, status: {} });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  let incoming: (query: MessageSearchQuery) => Promise<MessagePage> = async () => page([]);
  let history: ChatMessage[] = [];
  let contextError = false;
  let reads = 0;
  const searches: MessageSearchQuery[] = [];
  const warnings: unknown[] = [];
  const sourceLogger: PluginLogger = { ...logger, warn(message, detail) { warnings.push({ message, ...detail }); } };
  const connectors = { ...emptyConnectors, messages: {
    async identity() { return { accountId: "cli_app", userId: "ou_me" }; },
    async search(query: MessageSearchQuery) {
      if (discoveryKind && (query.chatType === "p2p" ? "direct" : query.senderIds ? "sent" : "mention") !== discoveryKind) return page([]);
      searches.push(query); return incoming(query);
    },
    async history() { reads++; if (contextError) throw new Error("Permission denied"); return page(history); },
    async thread() { reads++; if (contextError) throw new Error("Permission denied"); return page(history); },
  } };
  const resource = () => store.get<MessageWatch, MessageSourceStatus>(MESSAGE_SOURCE_TYPE, "messages");
  return { root, inputs, connectors, resource, searches, warnings, get resources() { return resources; }, get reads() { return reads; },
    incoming(fn: typeof incoming) { incoming = fn; }, history(rows: ChatMessage[]) { history = rows; },
    failContext(value: boolean) { contextError = value; },
    async restart() {
      const reopened = sessions.open(session.id); t.after(() => reopened.closeLogs());
      store = new PluginResourceStore({ home: reopened.home, pluginInstanceId: "personal" });
      resources = client(reopened);
    },
    observe(at = now) { return observeMessages({ logger: sourceLogger, resources }, resource(), connectors, at); },
  };
}

test("Direct messages include my speech; exact group mentions exclude bots, deleted messages and @all", async (t) => {
  const f = fixture(t);
  f.incoming(async (query) => page(query.chatType === "p2p"
    ? [message("om_dm", { mentions: [] }), message("om_self", { sender: { id: "ou_me", type: "user" } })]
    : [message("om_at"), message("om_all", { mentions: ["all"] }), message("om_deleted", { deleted: true }),
      message("om_bot", { sender: { id: "bot", type: "app" } })]));
  await f.observe();
  assert.equal(f.inputs.list().length, 3);
  assert.deepEqual(f.inputs.list().map((input) => input.spec.observation!.kind).sort(), ["direct", "direct", "mention"]);
  assert.deepEqual(f.inputs.list().map((input) => input.spec.relation).sort(), ["received", "received", "sent"]);
  assert.ok(f.inputs.list().every((input) => input.spec.originRef?.uid === f.resource().metadata.uid));
  assert.ok(f.inputs.list().every((input) => input.spec.text.includes(String((input.spec.observation!.message as { content: string }).content))));
  assert.ok(f.inputs.list().every((input) => input.spec.origin === "source" && input.spec.originId === SOURCES.lark.id && input.spec.topicKey === "lark:cli_app:oc_chat"));
  assert.ok(f.resource().status.scans!.every((scan) => scan.watermark === new Date(now).toISOString()));
  await f.observe(now + 60_000);
  assert.equal(f.inputs.list().length, 3, "Overlapping discovery and unchanged context remain silent");
  assert.equal(f.resource().status.pending!.length, 1, "Direct messages do not create duplicate follow-up Inputs");
});

test("Group thread identity is independent of sender and message; direct messages stay chat-scoped", async t => {
  const f = fixture(t);
  f.incoming(async query => page(query.chatType === "p2p" ? [message("dm", { threadId: "omt_dm" })] : [
    message("a", { threadId: "omt_a" }), message("a2", { threadId: "omt_a", sender: { type: "user", id: "ou_another" } }),
    message("b", { threadId: "omt_b" }), message("plain"),
  ]));
  await f.observe();
  const sessions = Object.fromEntries(f.inputs.list().map(i => [i.spec.observation!.originalMessageId, i.spec.topicKey]));
  assert.deepEqual(sessions, { dm: "lark:cli_app:oc_chat", a: "lark:cli_app:oc_chat:thread:omt_a",
    a2: "lark:cli_app:oc_chat:thread:omt_a", b: "lark:cli_app:oc_chat:thread:omt_b", plain: "lark:cli_app:oc_chat" });
});

test("Missing context submits the original message in the first poll and remains deduplicated after restart", async (t) => {
  const f = fixture(t, watch(), "mention");
  f.incoming(async () => page([message("om_at")]));
  f.failContext(true);
  await f.observe();
  assert.equal(f.inputs.list().length, 1);
  const input = f.inputs.list()[0]!;
  assert.equal(input.spec.text, "Lark 群内 @：om_at");
  assert.match(inputPreview(input), /"author":\{"id":"ou_other","type":"user"\}/);
  assert.match(inputPreview(input), /"mentions":\["ou_me"\]/);
  assert.equal(input.spec.topicKey, "lark:cli_app:oc_chat");
  assert.equal(Object.hasOwn(input.spec.observation!, "context"), false);
  assert.doesNotMatch(JSON.stringify(input.spec), /Permission denied/);
  assert.match(JSON.stringify(f.warnings), /Permission denied/);
  assert.match(JSON.stringify(f.warnings), /om_at/);
  assert.equal(f.resource().status.scans!.find((scan) => scan.kind === "mention")!.watermark, new Date(now).toISOString());
  await f.restart(); await f.observe(now + 60_000);
  assert.equal(f.inputs.list().length, 1);
});

test("Empty context is omitted; retrieved messages are included without read errors", async (t) => {
  const f = fixture(t, watch(), "direct");
  f.incoming(async () => page([message("om_empty", { mentions: [] })]));
  await f.observe();
  assert.equal(Object.hasOwn(f.inputs.list()[0]!.spec.observation!, "context"), false);
  f.incoming(async () => page([message("om_with_context", { mentions: [] })]));
  f.history([message("om_before", { content: "earlier discussion" })]);
  await f.observe(now + 60_000);
  const input = f.inputs.list().find((input) => input.spec.observation!.originalMessageId === "om_with_context")!;
  assert.deepEqual(input.spec.observation!.context, {
    messages: [{ ...message("om_before", { content: "earlier discussion" }), relation: "received", person: input.spec.sender }],
    observedThrough: new Date(now + 60_000).toISOString(), truncated: false,
  });
  assert.equal(f.warnings.length, 0);
});

test("An unavailable thread root is logged without discarding retrieved replies or embedding the error", async (t) => {
  const f = fixture(t, watch(), "mention");
  const anchor = message("om_at", { threadId: "omt_thread", threadPosition: "2" });
  const reply = message("om_reply", { threadId: "omt_thread", threadPosition: "3" });
  f.incoming(async () => page([anchor]));
  f.failContext(true);
  f.connectors.messages.thread = async () => page([anchor, reply]);
  await f.observe();
  assert.equal(f.inputs.list().length, 1);
  const context = f.inputs.list()[0]!.spec.observation!.context;
  assert.deepEqual(context, {
    messages: [{ ...reply, relation: "received", person: f.inputs.list()[0]!.spec.sender }], observedThrough: new Date(now).toISOString(), truncated: true, missingRoot: true,
  });
  assert.doesNotMatch(JSON.stringify(context), /Permission denied/);
  assert.match(JSON.stringify(f.warnings), /Permission denied/);
  assert.match(JSON.stringify(f.warnings), /omt_thread/);
});

test("Missing context never advances the watermark before its original Input is durable", async (t) => {
  const f = fixture(t, watch(), "direct");
  f.incoming(async () => page([message("om_dm", { mentions: [] })]));
  f.failContext(true);
  await assert.rejects(observeMessages({ logger, resources: { ...f.resources, async create(type, init) {
    if (type.kind === "Input") throw new Error("Input write failed");
    return f.resources.create(type, init);
  } } }, f.resource(), f.connectors, now), /Input write failed/);
  assert.equal(f.inputs.list().length, 0);
  assert.equal(f.resource().status.scans!.find((scan) => scan.kind === "direct")!.watermark, undefined);
  assert.ok(f.resource().status.pending![0]!.delivery);
  const reads = f.reads;
  f.failContext(false);
  await f.restart(); await f.observe(now + 60_000);
  assert.equal(f.inputs.list().length, 1);
  assert.equal(f.reads, reads, "Recovery submits the saved plan without reacquiring context");
  assert.equal(Object.hasOwn(f.inputs.list()[0]!.spec.observation!, "context"), false);
  assert.equal(f.resource().status.scans!.find((scan) => scan.kind === "direct")!.watermark, new Date(now).toISOString());
});

test("Crash after Input creation replays the saved delivery, not a changed live context", async (t) => {
  const f = fixture(t, watch(), "direct");
  f.incoming(async () => page([message("om_dm", { mentions: [] })]));
  f.history([message("om_context", { content: "original context" })]);
  let crashed = false;
  await assert.rejects(observeMessages({ logger, resources: { ...f.resources, async patchStatus(resource, patch) {
    if (!crashed && f.inputs.list().length && (patch as MessageSourceStatus).pending?.some((item) => item.sequence === 1)) {
      crashed = true; throw new Error("Crash after Input");
    }
    return f.resources.patchStatus(resource, patch);
  } } }, f.resource(), f.connectors, now), /Crash after Input/);
  assert.equal(f.inputs.list().length, 1);
  const reads = f.reads;
  f.history([message("om_context", { content: "changed context" })]);
  await f.restart(); await f.observe(now + 60_000);
  assert.equal(f.inputs.list().length, 1); assert.equal(f.reads, reads);
  assert.match(JSON.stringify(f.inputs.list()[0]!.spec), /original context/);
  assert.equal(f.resource().status.pending!.length, 0);
});

test("Search pages keep a fixed window across restart and never advance on provider failure", async (t) => {
  const f = fixture(t, watch(), "direct");
  let fail = false;
  f.incoming(async (query) => {
    if (fail) throw new Error("Search unavailable");
    return query.pageToken ? page([message("om_two")]) : page([message("om_one")], { hasMore: true, nextToken: "page2" });
  });
  await f.observe();
  assert.equal(f.resource().status.scans![0]!.watermark, undefined);
  assert.equal(f.resource().status.scans![0]!.window!.token, "page2");
  await f.restart();
  fail = true; await assert.rejects(f.observe(now + 60_000), /Search unavailable/);
  assert.equal(f.resource().status.scans![0]!.window!.token, "page2");
  fail = false; await f.observe(now + 120_000);
  assert.equal(f.searches.at(-1)!.end, new Date(now).toISOString());
  assert.equal(f.inputs.list().length, 2);
  assert.equal(f.resource().status.scans![0]!.watermark, new Date(now).toISOString());
});

test("Only associated replies trigger follow-up; duplicate polls stay silent and tracking expires", async (t) => {
  const f = fixture(t, watch({ followupMs: 120_000 }), "mention");
  f.incoming(async () => page([message("om_at")]));
  await f.observe();
  f.history([message("om_unrelated", { mentions: [], createdAt: new Date(now).toISOString() }),
    message("om_reply", { mentions: [], parentId: "om_at", createdAt: new Date(now).toISOString() })]);
  await f.observe(now + 60_000);
  assert.equal(f.inputs.list().length, 2);
  const update = f.inputs.list().find((input) => input.spec.observation!.kind === "discussion")!;
  assert.equal(update.spec.observation!.originalMessageId, "om_at");
  assert.equal(update.spec.relation, "observed");
  assert.ok(f.inputs.list().every((input) => input.spec.topicKey === "lark:cli_app:oc_chat"));
  assert.doesNotMatch(JSON.stringify(update.spec.observation!.context), /om_unrelated/);
  await f.observe(now + 120_000);
  assert.equal(f.inputs.list().length, 2); assert.equal(f.resource().status.pending!.length, 0);
  await f.observe(now + 180_000);
  assert.equal(f.inputs.list().length, 2);
});

test("Mention discovery and follow-up share Me identities independently of the execution account", async (t) => {
  for (const personIds of [["ou_human"], ["ou_human", "ou_second"], []]) {
    await t.test(`Me identities: ${personIds.join(",") || "execution fallback"}`, async (t) => {
      const target = personIds.at(-1) ?? "ou_me";
      const f = fixture(t, watch({ personIds }), "mention");
      const anchor = message("om_anchor", { mentions: [target] });
      f.incoming(async () => page([anchor]));
      await f.observe();
      const reply = message("om_again", { mentions: [target], parentId: anchor.id });
      const self = message("om_executor", { sender: { type: "user", id: "ou_me" }, mentions: [target], parentId: anchor.id });
      const bot = message("om_bot_reply", { sender: { type: "app", id: "bot" }, mentions: [target], parentId: anchor.id });
      f.incoming(async () => page([anchor, reply, self, bot]));
      f.history([reply, self, bot]);
      await f.observe(now + 60_000);
      const mentions = f.inputs.list().filter((input) => input.spec.observation!.kind === "mention");
      assert.deepEqual(mentions.map((input) => input.spec.observation!.originalMessageId).sort(), [anchor.id, reply.id, self.id].sort());
      const discussions = f.inputs.list().filter((input) => input.spec.observation!.kind === "discussion");
      assert.equal(discussions.length, 1);
      const context = discussions[0]!.spec.observation!.context as { messages: ChatMessage[] };
      assert.deepEqual(context.messages.map((message) => message.id), [bot.id], "Only messages without their own discovery Input enter follow-up");
      if (!personIds.length) assert.ok(f.inputs.list().every((input) => !Object.hasOwn(input.spec, "relation")), "Execution fallback leaves unknown relations absent");
      assert.equal(f.searches.some((query) => query.atMe), false, "Multiple, different or unconfigured Me identities cannot use the execution-user search filter");
    });
  }
});

test("Failed direct search does not starve mentions, and an expired follow-up logs failure without another Input", async (t) => {
  const f = fixture(t, watch({ followupMs: 60_000 }));
  f.incoming(async (query) => {
    if (query.chatType === "p2p") throw new Error("Direct search unavailable");
    return page([message("om_at")]);
  });
  await assert.rejects(f.observe(), /Direct search unavailable/);
  assert.equal(f.inputs.list().length, 1);
  f.failContext(true);
  await assert.rejects(f.observe(now + 60_000), /Direct search unavailable/);
  assert.equal(f.inputs.list().length, 1);
  assert.doesNotMatch(JSON.stringify(f.inputs.list()), /Permission denied/);
  assert.match(JSON.stringify(f.warnings), /Permission denied/);
  assert.equal(f.resource().status.pending!.length, 0);
  await assert.rejects(f.observe(now + 120_000), /Direct search unavailable/);
  assert.equal(f.inputs.list().length, 1);
});

test("Follow-up pagination resumes across restart and a terminal delivery survives a crash without repeated Inputs", async (t) => {
  const f = fixture(t, watch({ followupMs: 60_000 }), "mention");
  f.incoming(async () => page([message("om_at", { threadId: "omt_thread", threadPosition: "-1" })]));
  await f.observe();
  let calls = 0;
  f.connectors.messages.thread = async () => {
    calls++;
    return page([message(calls === 1 ? "om_reply1" : "om_reply2", { mentions: [], threadId: "omt_thread" })],
      calls === 1 ? { hasMore: true, nextToken: "page2" } : {});
  };
  await f.observe(now + 60_000);
  assert.equal(f.resource().status.pending![0]!.follow!.token, "page2");
  await f.restart();
  let crashed = false;
  await assert.rejects(observeMessages({ logger, resources: { ...f.resources, async patchStatus(resource, patch) {
    if (!crashed && f.inputs.list().length === 3 && (patch as MessageSourceStatus).pending?.some((entry) => entry.sequence === 3)) {
      crashed = true; throw new Error("Crash on terminal delivery");
    }
    return f.resources.patchStatus(resource, patch);
  } } }, f.resource(), f.connectors, now + 120_000), /Crash on terminal delivery/);
  assert.equal(f.inputs.list().length, 3);
  await f.restart(); await f.observe(now + 180_000);
  assert.equal(f.inputs.list().length, 3); assert.equal(f.resource().status.pending!.length, 0);
  assert.equal(calls, 2);
  assert.ok(f.inputs.list().every(input => input.spec.topicKey === "lark:cli_app:oc_chat:thread:omt_thread"));
});

test("Thread context uses explicit thread reads, bounds text and reports incomplete pages", async () => {
  let historyCalls = 0;
  const messages = { ...emptyConnectors.messages, async history() { historyCalls++; return page([]); },
    async thread() { return page([message("om_reply", { content: "x".repeat(2000), threadId: "omt_thread" })], { hasMore: true, nextToken: "next" }); } };
  const context = await readMessageContext(messages, message("om_at", { threadId: "omt_thread", threadPosition: "-1" }), watch({ maxContextChars: 1000 }), now, logger);
  assert.equal(historyCalls, 0); assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0]!.content.length, 1000); assert.equal(context.truncated, true);
});

test("Thread root is loaded from nearby group history; unavailable roots remain explicit gaps", async () => {
  const anchor = message("om_at", { threadId: "omt_thread", threadPosition: "2" });
  const root = message("om_root", { threadId: "omt_thread", threadPosition: "-1" });
  const connector = { ...emptyConnectors.messages, async thread() { return page([anchor]); },
    async history() { return page([root]); } };
  const found = await readMessageContext(connector, anchor, watch(), now, logger);
  assert.equal(found.missingRoot, false); assert.equal(found.messages[0]!.id, root.id);
  const missing = await readMessageContext({ ...connector, async history() { return page([]); } }, anchor, watch(), now, logger);
  assert.equal(missing.missingRoot, true); assert.equal(missing.truncated, true);
});

test("Message observation requires an account and has no configurable kinds", () => {
  assert.equal(messageWatch(undefined), undefined);
  assert.throws(() => messageWatch(MessageWatchSchema.parse({})), /connectors.lark/);
  assert.deepEqual(messageWatch(MessageWatchSchema.parse({}), { appId: "cli_app", userId: "ou_me" })!.personIds, []);
  assert.deepEqual(messageWatch(MessageWatchSchema.parse({}), { appId: "cli_other", userId: "ou_me" }, person)!.personIds, []);
  assert.deepEqual(messageWatch(MessageWatchSchema.parse({}), { appId: "cli_app", userId: "ou_other" }, person)!.personIds, ["ou_me"]);
  assert.throws(() => MessageWatchSchema.parse({ kinds: ["direct"] }));
  assert.throws(() => MessageWatchSchema.parse({ contextAttempts: 2 }));
});

test("Discussion batches retain each person's relation; replies to my own messages are received", async (t) => {
  const f = fixture(t);
  const mine = message("om_mine", { sender: { id: "ou_me", type: "user" }, mentions: [], parentId: "om_at" });
  const reply = message("om_reply_to_me", { mentions: [], parentId: mine.id });
  const ambient = message("om_ambient", { mentions: [], parentId: "om_at" });
  assert.equal(messageRelation(watch(), mine, false), "sent");
  const alternate = message("om_alternate", { sender: { id: "ou_second", type: "user" }, mentions: [] });
  assert.equal(messageRelation(watch({ personIds: ["ou_me", "ou_second"] }), alternate, true), "sent");
  assert.equal(messageRelation(watch(), alternate, true), "received");
  assert.equal(messageRelation(watch(), reply, false, [mine]), "received");
  f.incoming(async query => page(query.chatType === "group" && !query.senderIds ? [message("om_at")] : []));
  await f.observe();
  f.history([mine, reply, ambient]);
  f.incoming(async query => page(query.chatType === "p2p" ? [] : query.senderIds ? [mine] : [message("om_at")]));
  await f.observe(now + 60_000);
  const sent = f.inputs.list().find(input => input.spec.observation!.kind === "sent")!;
  assert.equal(sent.spec.relation, "sent");
  assert.match(inputPreview(sent), /"relationToMe":"sent"/);
  const update = f.inputs.list().find((input) => input.spec.observation!.kind === "discussion")!;
  assert.equal(update.spec.relation, "observed");
  const context = update.spec.observation!.context as { messages: Array<{ id: string; relation: string }> };
  assert.deepEqual(context.messages.map(({ id, relation }) => [id, relation]), [
    [reply.id, "received"], [ambient.id, "observed"],
  ]);
  const preview = inputPreview(update);
  for (const [item, relation] of [[reply, "received"], [ambient, "observed"]] as const) {
    assert.ok(preview.includes(`${JSON.stringify({ messageId: item.id, at: item.createdAt, author: { id: item.sender.id, type: item.sender.type },
      relationToMe: relation, mentions: item.mentions, replyToMessageId: item.parentId })}\n${item.content}`),
      "Every follow-up keeps its author and relation adjacent to its text, without expanding observation");
  }
  assert.match(preview, /"scope":"cli_app","observerId":"ou_me"/);
});

/** @case Source creates the topic without a reply address; Channel reuses it and replies to its incoming address. */
test("Real Runner shares Lark chat topics across Source and Channel without inferring a Source reply address", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-message-runner-"));
  const configFile = join(root, "config.yaml");
  writeFileSync(configFile, JSON.stringify({ connectors: { lark: { appId: "cli_app", userId: "ou_me", me: [{ appId: "cli_app", openId: "ou_me" }] } },
    plugins: { personal: { sources: { lark: {} } } } }));
  let searches = 0;
  const prompts: string[] = [];
  const options = { ...fakeOptions({ chief: async (prompt) => {
    const activation = JSON.parse(prompt.split("Activation: ")[1]!.split("\n")[0]!);
    return activation.inputs[0].description.includes("Origin: source/") ? "source-private-reply" : "channel-reply";
  }, async execute() { throw new Error("Unexpected work"); } }, root, prompts, root, "cli_app"), config: loadConfig(configFile),
    connectors: { ...emptyConnectors, messages: {
      async identity() { return { accountId: "cli_app", userId: "ou_me" }; },
      async search(query: MessageSearchQuery) {
        searches++;
        return page(query.chatType === "p2p" ? [message("om_dm", { mentions: [] })]
          : [message("om_at", { chatId: "oc_group" }), message("om_at_again", { chatId: "oc_group" })]);
      },
      async history() { return page([]); }, async thread() { return page([]); },
    } } };
  let aide = new Aide(root, options, pino({ level: "silent" }));
  const sent: Array<{ chatId: string; text: string }> = [];
  const channelFor = () => new LarkChannel(root, "cli_app", aide, {
    botIdentity: { openId: "ou_bot", name: "Aide" },
    async start() {}, close() {}, async chatName() { return undefined; }, async send(chatId, text) { sent.push({ chatId, text }); },
  }, pino({ level: "silent" }));
  let channel = channelFor();
  t.after(async () => { await channel.close(); await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.personal.topics.ensure("inbox", fixtureAddress("inbox"));
  await aide.topics.ensure("default");
  // Persist a registered bot chat before observing user messages, but defer processing its request.
  await channel.receive({ sender: { sender_type: "user" }, message: {
    message_id: "om_channel", chat_id: "oc_group", chat_type: "group", message_type: "text",
    content: JSON.stringify({ text: "@_user_1 channel request" }),
    mentions: [{ key: "@_user_1", id: { open_id: "ou_bot" } }],
  } });
  await aide.receive(fixtureIncoming({ channelId: "web", topicKey: "inbox", topicId: "inbox", id: "hello", text: "hello" }));
  await aide.start(); await aide.settled();
  const inputs = aide.personal.topics.inputStore;
  assert.equal(inputs.list().filter((input) => input.spec.originId === "personal.lark").length, 3);
  assert.ok(!aide.outputs().some((reply) => reply.text === "source-private-reply"), "An observed chat is not a default reply address");
  await channel.deliver();
  assert.deepEqual(sent, [], "Observing a user mention must not send Source replies to the registered bot chat");
  const observed = inputs.list().filter((input) => input.spec.originId === "personal.lark")[0]!;
  assert.ok(observed.spec.sender);
  const sender = await aide.persons.read(observed.spec.sender.name);
  assert.equal(sender.metadata.uid, observed.spec.sender.uid);
  assert.equal(sender.spec.identities[0]!.id, "ou_other");
  assert.equal(sender.isMe, false);
  assert.equal(observed.spec.observation!.originalInputId, observed.metadata.name);
  assert.ok(observed.status.route?.completedAt);
  assert.ok(prompts.some((prompt) => prompt.includes("om_dm")));
  for (const chatId of ["oc_chat", "oc_group"]) {
    const sessionId = `lark:cli_app:${chatId}`;
    const store = aide.personal.topics;
    const expected = inputs.list().filter((input) => input.spec.originId === "personal.lark").filter((input) => input.spec.topicKey === sessionId).map((input) => input.metadata.name).sort();
    assert.equal(store.list().filter((c) => c.topicKey === sessionId).length, 1, "Messages from the same observed chat reuse one Topic");
    assert.equal(store.byKey(sessionId)!.spec.address, undefined);
    assert.deepEqual([...store.inputs(store.byKey(sessionId)!.spec.id).map((i) => i.metadata.name)].sort(), expected);
    for (const id of expected) assert.equal(aide.personal.topics.input(id, "inbox"), undefined);
  }
  assert.equal(aide.personal.topics.list().filter((c) => c.id === MESSAGE_SESSION).length, 0);
  const sourceGroupId = aide.topics.byKey("lark:cli_app:oc_group")!.spec.id;
  const sourceGroupUid = aide.personal.topics.resource(sourceGroupId)!.metadata.uid;
  const groupId = sourceGroupId;
  await channel.dispatch(); await aide.settled(); await channel.deliver();
  assert.deepEqual(sent, [{ chatId: "oc_group", text: "channel-reply" }]);
  const reply = aide.outputs().find(output => output.topicId === groupId && output.text === "channel-reply")!;
  assert.ok(larkProgress(aide, groupId).some(view => view.messageIds.includes(reply.id)), "Cards match the incoming address even without a Topic default address");
  const store = aide.personal.topics;
  assert.equal(store.list().filter((c) => c.id === groupId).length, 1);
  assert.equal(store.inputs(groupId).length, 3);
  assert.equal(store.resource(groupId)!.metadata.uid, sourceGroupUid);
  const channelInput = store.inputs(groupId).find(input => input.spec.origin === "channel")!;
  assert.equal(channelInput.spec.origin, "channel");
  assert.equal(channelInput.spec.topicKey, "lark:cli_app:oc_group");
  assert.equal(aide.personal.topics.input(channelInput.metadata.name, "inbox"), undefined);
  const channelPrompt = prompts.filter(prompt => prompt.includes("Activation: ")).find((prompt) => JSON.parse(prompt.split("Activation: ")[1]!.split("\n")[0]!).topicId === groupId)!;
  assert.ok(channelPrompt);
  const groupUid = store.resource(groupId)!.metadata.uid;
  const previous = searches;
  aide.topics.get("another"); await aide.settled();
  assert.equal(searches, previous);
  await channel.close(); await aide.close(); aide = new Aide(root, options, pino({ level: "silent" }));
  channel = channelFor();
  await aide.start(); await aide.settled(); await channel.dispatch(); await channel.deliver();
  assert.deepEqual(sent, [{ chatId: "oc_group", text: "channel-reply" }], "Restart must neither leak historical Source replies nor duplicate delivered Channel replies");
  assert.equal(aide.personal.topics.inputStore.list().filter((input) => input.spec.originId === "personal.lark").length, 3);
  assert.equal(aide.personal.topics.resource(groupId)!.metadata.uid, groupUid);
  assert.equal(aide.personal.topics.inputs(groupId).length, 3);
  assert.equal(aide.personal.topics.resource(sourceGroupId)!.metadata.uid, sourceGroupUid);
  assert.equal(aide.works().length, 0);
});

/** @case Me asking a colleague to change configuration is observed as sent, never as a request to Aide. */
test("Group speech from explicit Me identities is independently discovered with stable topic affinity", async t => {
  const f = fixture(t, watch({ personIds: ["ou_human", "ou_second"] }), "sent");
  const mine = message("om_config", { sender: { id: "ou_human", type: "user" }, mentions: ["ou_colleague"],
    content: "@colleague Please update workspaceSync.trustedDownloadHosts" });
  const plain = message("om_plain", { sender: { id: "ou_second", type: "user" }, mentions: [] });
  const threaded = message("om_threaded", { ...mine, id: "om_threaded", threadId: "omt_topic" });
  f.incoming(async query => {
    assert.deepEqual(query.senderIds, ["ou_human", "ou_second"]);
    assert.equal(query.chatType, "group"); assert.equal(query.atMe, undefined);
    return page([mine, plain, threaded, message("om_login", { sender: { id: "ou_me", type: "user" }, mentions: [] }),
      message("om_other", { mentions: [] }), { ...mine, id: "om_deleted", deleted: true },
      { ...mine, id: "om_bot", sender: { id: "ou_human", type: "app" } }]);
  });
  await f.observe();
  assert.equal(f.inputs.list().length, 3);
  for (const input of f.inputs.list()) {
    assert.equal(input.spec.origin, "source"); assert.equal(input.spec.relation, "sent");
    assert.equal(input.spec.observation!.kind, "sent"); assert.ok(input.spec.sender);
    assert.match(inputPreview(input), /observation is not itself a direct request to Aide/);
    assert.match(inputPreview(input), /"relationToMe":"sent"/);
    assert.equal(input.spec.topicKey, input.spec.observation!.originalMessageId === threaded.id
      ? "lark:cli_app:oc_chat:thread:omt_topic" : "lark:cli_app:oc_chat");
  }
  await f.restart(); await f.observe(now + 60_000);
  assert.equal(f.inputs.list().length, 3);
  assert.equal(f.resource().status.scans!.find(scan => scan.kind === "sent")!.watermark, new Date(now + 60_000).toISOString());
});

test("Sent and mention searches share deduplication and keep separate pagination progress", async t => {
  const f = fixture(t);
  const both = message("om_both", { sender: { id: "ou_me", type: "user" } });
  const sent = message("om_sent", { sender: { id: "ou_me", type: "user" }, mentions: ["ou_colleague"] });
  f.incoming(async query => query.chatType === "p2p" ? page([]) : !query.senderIds ? page([both])
    : query.pageToken ? page([sent]) : page([both], { hasMore: true, nextToken: "sent-page-2" }));
  await f.observe();
  assert.equal(f.inputs.list().length, 1);
  assert.equal(f.resource().status.scans!.find(scan => scan.kind === "sent")!.watermark, undefined);
  assert.equal(f.resource().status.scans!.find(scan => scan.kind === "mention")!.watermark, new Date(now).toISOString());
  await f.restart(); await f.observe(now + 60_000);
  assert.equal(f.inputs.list().length, 2);
  assert.ok(f.inputs.list().every(input => input.spec.relation === "sent"));
  assert.equal(f.searches.filter(query => query.senderIds).at(-1)!.end, new Date(now).toISOString());
  assert.equal(f.resource().status.scans!.find(scan => scan.kind === "sent")!.watermark, new Date(now).toISOString());
});

test("Missing explicit Me identities never enables a login-owner sent scan", async t => {
  const f = fixture(t, watch({ personIds: [] }));
  f.incoming(async query => {
    assert.equal(query.senderIds, undefined);
    return page(query.chatType === "p2p" ? [] : [message("om_login", { sender: { id: "ou_me", type: "user" }, mentions: [] })]);
  });
  await f.observe();
  assert.equal(f.inputs.list().length, 0);
  assert.equal(f.resource().status.scans!.some(scan => scan.kind === "sent"), false);
});

test("Lark Source freezes readable chat names and preserves them in compact model context", async t => {
  const f = fixture(t);
  const group = message("om_group_name", { chatId: "oc_group", chatName: "DBA 优化讨论", content: "@Me" });
  const threaded = message("om_thread_name", { chatId: "oc_group", chatName: "DBA 优化讨论", threadId: "omt_named",
    rootId: "om_root", content: "请看看" });
  const direct = message("om_dm_name", { chatName: "李萌", mentions: [], sender: { id: "ou_me", type: "user" } });
  f.incoming(async query => page(query.chatType === "p2p" ? [direct] : query.senderIds ? [] : [group, threaded]));
  f.history([message("om_root", { threadId: "omt_named", content: "OB 查询优化" })]);
  await f.observe();
  const inputs = f.inputs.list();
  const named = inputs.find(i => i.spec.observation?.originalMessageId === group.id)!;
  assert.equal(named.spec.topicName, "DBA 优化讨论");
  assert.equal(named.spec.topicKey, "lark:cli_app:oc_group");
  assert.equal((named.spec.observation!.message as ChatMessage).chatName, group.chatName);
  assert.match(inputPreview(named), /DBA 优化讨论/);
  assert.equal(inputs.find(i => i.spec.observation?.originalMessageId === threaded.id)!.spec.topicName, "DBA 优化讨论 · OB 查询优化");
  assert.equal(inputs.find(i => i.spec.observation?.originalMessageId === direct.id)!.spec.topicName, "李萌");
  await f.restart(); await f.observe(now + 1000);
  assert.equal(f.inputs.list().length, inputs.length);
});
