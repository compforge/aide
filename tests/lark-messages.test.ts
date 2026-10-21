import assert from "node:assert/strict";
import { test } from "node:test";
import { LarkMessages, larkFailure } from "../connectors/lark/messages.ts";
import { LarkMessagesConfigSchema } from "../connectors/lark/config.ts";
import { createConnectorClient, dispatchConnector, emptyConnectors } from "../src/connector-client.ts";
import { chiefTools } from "../agents/chief/chief-tools.ts";

const config = { ...LarkMessagesConfigSchema.parse({ appId: "cli_app", userId: "ou_me" }), appId: "cli_app", userId: "ou_me" };
const identity = { appId: "cli_app", identities: { user: { available: true, openId: "ou_me" } } };
const row = { message_id: "om_one", chat_id: "oc_chat", content: "hello", create_time: "2026-10-20 07:37",
  deleted: false, sender: { id: "ou_other", sender_type: "user", name: "Colleague" },
  mentions: [{ id: "ou_me", name: "Me" }], reply_to: "om_parent", thread_id: "omt_thread" };
const query = { start: "2026-10-20T07:00:00Z", end: "2026-10-20T08:00:00Z" };
const response = { ok: true, identity: "user", data: { messages: [row], has_more: true, page_token: "next" } };

test("Lark Connector pins user identity, maps UTC compact rows, and preserves single-page continuation over IPC", async () => {
  const commands: string[][] = [];
  const messages = new LarkMessages(config, async (args) => {
    commands.push([...args]); return args[0] === "auth" ? identity : response;
  });
  const host = { ...emptyConnectors, messages };
  const client = createConnectorClient(async <T>(request: Parameters<typeof dispatchConnector>[1]): Promise<T> =>
    await dispatchConnector(host, request) as T);
  const page = await client.messages.search({ ...query, chatType: "group", atMe: true, pageToken: "previous", limit: 2 });
  assert.equal(page.nextToken, "next");
  assert.equal(page.messages[0]!.createdAt, "2026-10-20T07:37:00.000Z");
  assert.equal(page.messages[0]!.parentId, "om_parent");
  assert.deepEqual(page.messages[0]!.mentions, ["ou_me"]);
  assert.deepEqual(commands[1], ["im", "+messages-search", "--is-at-me", "--chat-type", "group", "--sender-type", "user",
    "--start", "2026-10-20T07:00:00+00:00", "--end", "2026-10-20T08:00:00+00:00", "--page-size", "2", "--page-token", "previous",
    "--as", "user", "--no-reactions", "--format", "json"]);
  await client.messages.search({ ...query, chatType: "p2p" });
  assert.ok(!commands[3]!.includes("--is-at-me"));
  assert.ok(commands[3]!.includes("p2p"));
  const tools = chiefTools(client, async () => {}, () => {});
  await tools.find((tool) => tool.name === "read_chat_messages")!.execute("read", { ...query, chatId: "oc_chat" }, undefined, undefined, {} as never);
  await tools.find((tool) => tool.name === "read_thread_messages")!.execute("read", { threadId: "omt_thread" }, undefined, undefined, {} as never);
  assert.ok(commands.some((args) => args.includes("+chat-messages-list")));
  assert.ok(commands.some((args) => args.includes("+threads-messages-list")));
});

test("Lark reads reject account switches, incomplete output, malformed pages and expose sanitized permission errors", async () => {
  let value: unknown = { ...identity, appId: "cli_other" };
  let reads = 0;
  const connector = new LarkMessages(config, async (args) => {
    if (args[0] === "auth") return value;
    reads++; return response;
  });
  await assert.rejects(connector.search(query), /does not match/); assert.equal(reads, 0);
  value = { ...identity, identities: { user: { available: true, openId: "ou_other" } } };
  await assert.rejects(connector.history({ ...query, chatId: "oc_chat" }), /does not match/);
  for (const data of [
    { messages: [row], has_more: true },
    { messages: [{ ...row, sender: undefined }], has_more: false },
    { messages: [row] },
  ]) {
    const broken = new LarkMessages(config, async (args) => args[0] === "auth" ? identity : { ok: true, identity: "user", data });
    await assert.rejects(broken.search(query));
  }
  const error = larkFailure({ error: { type: "authorization", subtype: "missing_scope", message: "secret token",
    missing_scopes: ["im:message.group_msg:get_as_user"] } });
  assert.match(error.message, /im:message.group_msg:get_as_user/);
  assert.doesNotMatch(error.message, /secret/);
  assert.throws(() => connector.history({ ...query, chatId: "--bad" }));
});

test("Lark process concurrency is bounded and released after a failure", async () => {
  const releases: Array<() => void> = [];
  const connector = new LarkMessages(config, async (args) => {
    if (args[0] === "auth") return identity;
    await new Promise<void>((resolve) => releases.push(resolve)); return response;
  });
  const one = connector.search(query); const two = connector.search(query);
  await assert.rejects(connector.search(query), /concurrency limit/);
  await new Promise((resolve) => setImmediate(resolve));
  releases.forEach((release) => release()); await Promise.all([one, two]);
});
