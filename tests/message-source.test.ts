import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { ChatMessage, MessagePage, MessageSearchQuery } from "@compforge/aide-plugin";
import { SessionStore } from "../src/host/store/store.ts";
import { InputStore } from "../src/host/input/store.ts";
import { AideResourceProvider } from "../src/host/plugin/aide-resource.ts";
import { PluginResourceStore } from "../src/host/plugin/resource.ts";
import { createResourceClient } from "../src/host/plugin/resource-client.ts";
import { emptyConnectors } from "../src/connector-client.ts";
import { MESSAGE_SOURCE_TYPE, observeMessages, type MessageSourceStatus } from "../plugins/personal/message-source.ts";
import { messageWatch, MESSAGE_SESSION, type MessageWatch } from "../plugins/personal/message-config.ts";
import { readMessageContext } from "../plugins/personal/message-context.ts";
import { Aide } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { fakeOptions } from "./fake-harness.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const now = Date.parse("2026-10-20T08:00:00Z");
const message = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({
  id, chatId: "oc_chat", sender: { id: "ou_other", type: "user" }, content: id,
  createdAt: new Date(now - 60_000).toISOString(), deleted: false, mentions: ["ou_me"], ...patch,
});
const page = (messages: ChatMessage[], extra: Partial<MessagePage> = {}): MessagePage =>
  ({ messages, hasMore: false, observedThrough: new Date(now).toISOString(), ...extra });
const watch = (patch: Partial<MessageWatch> = {}) => ({ ...messageWatch({ messages: {} }, { appId: "cli_app", userId: "ou_me" })!, ...patch });

function fixture(t: TestContext, spec = watch()) {
  const root = mkdtempSync(join(tmpdir(), "aide-message-source-"));
  const sessions = new SessionStore(root); const session = sessions.createSession({ id: MESSAGE_SESSION, cwd: root });
  const inputs = new InputStore(root);
  let store = new PluginResourceStore({ session, pluginInstanceId: "personal" });
  let resources = createResourceClient(store, undefined, undefined, new AideResourceProvider({ session, inputs }));
  store.create({ type: MESSAGE_SOURCE_TYPE, name: "messages", spec, status: {} });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  let incoming: (query: MessageSearchQuery) => Promise<MessagePage> = async () => page([]);
  let history: ChatMessage[] = [];
  let contextError = false;
  let reads = 0;
  const searches: MessageSearchQuery[] = [];
  const connectors = { ...emptyConnectors, messages: {
    async identity() { return { accountId: "cli_app", userId: "ou_me" }; },
    async search(query: MessageSearchQuery) { searches.push(query); return incoming(query); },
    async history() { reads++; if (contextError) throw new Error("Permission denied"); return page(history); },
    async thread() { reads++; if (contextError) throw new Error("Permission denied"); return page(history); },
  } };
  const resource = () => store.get<MessageWatch, MessageSourceStatus>(MESSAGE_SOURCE_TYPE, "messages");
  return { root, inputs, connectors, resource, searches, get resources() { return resources; }, get reads() { return reads; },
    incoming(fn: typeof incoming) { incoming = fn; }, history(rows: ChatMessage[]) { history = rows; },
    failContext(value: boolean) { contextError = value; },
    async restart() {
      const reopened = sessions.openSession(session.id); t.after(() => reopened.closeLogs());
      store = new PluginResourceStore({ session: reopened, pluginInstanceId: "personal" });
      resources = createResourceClient(store, undefined, undefined, new AideResourceProvider({ session: reopened, inputs }));
    },
    observe(at = now) { return observeMessages({ logger, resources }, resource(), connectors, at); },
  };
}

test("Direct and exact group mentions produce independent Inputs; self, bots, deleted and @all are excluded", async (t) => {
  const f = fixture(t);
  f.incoming(async (query) => page(query.chatType === "p2p"
    ? [message("om_dm", { mentions: [] }), message("om_self", { sender: { id: "ou_me", type: "user" } })]
    : [message("om_at"), message("om_all", { mentions: ["all"] }), message("om_deleted", { deleted: true }),
      message("om_bot", { sender: { id: "bot", type: "app" } })]));
  await f.observe();
  assert.equal(f.inputs.list().length, 2);
  assert.deepEqual(f.inputs.list().map((input) => input.spec.observation!.kind).sort(), ["direct", "mention"]);
  assert.ok(f.inputs.list().every((input) => input.spec.origin === "source" && !input.spec.sessionId));
  assert.ok(f.resource().status.scans!.every((scan) => scan.watermark === new Date(now).toISOString()));
  await f.observe(now + 60_000);
  assert.equal(f.inputs.list().length, 2, "Overlapping discovery and unchanged context remain silent");
  assert.equal(f.resource().status.pending!.length, 1, "Direct messages do not create duplicate follow-up Inputs");
});

test("A failed context is durable, retries independently, and publishes the missing-context fact before advancing the scan", async (t) => {
  const f = fixture(t, watch({ kinds: ["mention"] }));
  f.incoming(async () => page([message("om_at")]));
  f.failContext(true);
  await f.observe();
  assert.equal(f.inputs.list().length, 0);
  assert.equal(f.resource().status.pending![0]!.attempts, 1);
  assert.equal(f.resource().status.scans![0]!.watermark, undefined);
  await f.restart(); await f.observe(now + 60_000);
  assert.equal(f.inputs.list().length, 1);
  assert.match(JSON.stringify(f.inputs.list()[0]!.spec.observation!.context), /Permission denied/);
  assert.equal(f.resource().status.scans![0]!.watermark, new Date(now).toISOString());
});

test("Crash after Input creation replays the saved delivery, not a changed live context", async (t) => {
  const f = fixture(t, watch({ kinds: ["direct"] }));
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
  const f = fixture(t, watch({ kinds: ["direct"] }));
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
  const f = fixture(t, watch({ kinds: ["mention"], followupMs: 120_000 }));
  f.incoming(async () => page([message("om_at")]));
  await f.observe();
  f.history([message("om_unrelated", { mentions: [], createdAt: new Date(now).toISOString() }),
    message("om_reply", { mentions: [], parentId: "om_at", createdAt: new Date(now).toISOString() })]);
  await f.observe(now + 60_000);
  assert.equal(f.inputs.list().length, 2);
  const update = f.inputs.list().find((input) => input.spec.observation!.kind === "discussion")!;
  assert.equal(update.spec.observation!.originalMessageId, "om_at");
  assert.doesNotMatch(JSON.stringify(update.spec.observation!.context), /om_unrelated/);
  await f.observe(now + 120_000);
  assert.equal(f.inputs.list().length, 2); assert.equal(f.resource().status.pending!.length, 0);
  await f.observe(now + 180_000);
  assert.equal(f.inputs.list().length, 2);
});

test("Failed direct search does not starve mentions, and an expired follow-up reports its permission gap once", async (t) => {
  const f = fixture(t, watch({ followupMs: 60_000 }));
  f.incoming(async (query) => {
    if (query.chatType === "p2p") throw new Error("Direct search unavailable");
    return page([message("om_at")]);
  });
  await assert.rejects(f.observe(), /Direct search unavailable/);
  assert.equal(f.inputs.list().length, 1);
  f.failContext(true);
  await assert.rejects(f.observe(now + 60_000), /Direct search unavailable/);
  assert.equal(f.inputs.list().length, 2);
  assert.match(JSON.stringify(f.inputs.list().at(-1)!.spec), /Permission denied/);
  assert.equal(f.resource().status.pending!.length, 0);
  await assert.rejects(f.observe(now + 120_000), /Direct search unavailable/);
  assert.equal(f.inputs.list().length, 2);
});

test("Follow-up pagination resumes across restart and a terminal delivery survives a crash without repeated Inputs", async (t) => {
  const f = fixture(t, watch({ kinds: ["mention"], followupMs: 60_000 }));
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
});

test("Thread context uses explicit thread reads, bounds text and reports incomplete pages", async () => {
  let historyCalls = 0;
  const messages = { ...emptyConnectors.messages, async history() { historyCalls++; return page([]); },
    async thread() { return page([message("om_reply", { content: "x".repeat(2000), threadId: "omt_thread" })], { hasMore: true, nextToken: "next" }); } };
  const context = await readMessageContext(messages, message("om_at", { threadId: "omt_thread", threadPosition: "-1" }), watch({ maxContextChars: 1000 }), now);
  assert.equal(historyCalls, 0); assert.equal(context.messages.length, 1);
  assert.equal(context.messages[0]!.content.length, 1000); assert.equal(context.truncated, true);
});

test("Thread root is loaded from nearby group history; unavailable roots remain explicit gaps", async () => {
  const anchor = message("om_at", { threadId: "omt_thread", threadPosition: "2" });
  const root = message("om_root", { threadId: "omt_thread", threadPosition: "-1" });
  const connector = { ...emptyConnectors.messages, async thread() { return page([anchor]); },
    async history() { return page([root]); } };
  const found = await readMessageContext(connector, anchor, watch(), now);
  assert.equal(found.missingRoot, false); assert.equal(found.messages[0]!.id, root.id);
  const missing = await readMessageContext({ ...connector, async history() { return page([]); } }, anchor, watch(), now);
  assert.equal(missing.missingRoot, true); assert.equal(missing.truncated, true);
});

test("Message observation is opt-in and rejects missing account, unsupported kinds and duplicate policy entries", () => {
  assert.equal(messageWatch(), undefined);
  assert.equal(messageWatch({ messages: { kinds: [] } }), undefined);
  assert.throws(() => messageWatch({ messages: {} }), /connectors.feishu/);
  assert.throws(() => messageWatch({ messages: { kinds: ["group"] } }, { appId: "cli_app", userId: "ou_me" }));
  assert.throws(() => messageWatch({ messages: { kinds: ["direct", "direct"] } }, { appId: "cli_app", userId: "ou_me" }));
});

test("Real Runner discovers IM through Connector IPC, routes an Input once, and restores without duplicating the observer", { timeout: 20_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-message-runner-"));
  const configFile = join(root, "config.yaml");
  writeFileSync(configFile, JSON.stringify({ connectors: { feishu: { appId: "cli_app", userId: "ou_me" } },
    plugins: { personal: { messages: { kinds: ["direct"] } } } }));
  let searches = 0;
  const prompts: string[] = [];
  const options = { ...fakeOptions({ chief: async (prompt) => prompt.includes("Candidates:")
    ? JSON.stringify({ conversationIds: ["inbox"], reason: "new message" }) : "同事有新消息",
    async execute() { throw new Error("Unexpected work"); } }, root, prompts), config: loadConfig(configFile),
    connectors: { ...emptyConnectors, messages: {
      async identity() { return { accountId: "cli_app", userId: "ou_me" }; },
      async search() { searches++; return page([message("om_dm", { mentions: [] })]); },
      async history() { return page([]); }, async thread() { return page([]); },
    } } };
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.receive({ sessionId: "inbox", conversationId: "inbox", id: "hello", text: "hello" });
  await aide.start(); await aide.settled();
  const inputs = aide.session(MESSAGE_SESSION).conversations.inputStore;
  assert.equal(inputs.list(MESSAGE_SESSION).length, 1);
  assert.ok(inputs.list(MESSAGE_SESSION)[0]!.status.routing?.phase === "done");
  assert.ok(prompts.some((prompt) => prompt.includes("om_dm")));
  const previous = searches;
  aide.session("another"); await aide.settled();
  assert.equal(searches, previous);
  await aide.close(); aide = new Aide(root, options, pino({ level: "silent" }));
  await aide.start(); await aide.settled();
  assert.equal(aide.session(MESSAGE_SESSION).conversations.inputStore.list(MESSAGE_SESSION).length, 1);
  assert.equal(aide.works().length, 0);
});
