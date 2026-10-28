import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { PersonSchema } from "../plugins/personal/person/model.ts";
import { channelRelation, relationToPerson } from "../plugins/personal/person/relation.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { inputPrinter } from "../plugins/personal/input/printer.ts";
import { Aide } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { LarkChannel } from "../src/channel/lark/index.ts";
import { fakeOptions } from "./fake-harness.ts";

const me = { provider: "lark", scope: "cli_app", id: "ou_me" };
const person = { identities: [me] };

test("Person identity matches the provider, scope and subject; incomplete evidence stays unknown", () => {
  assert.equal(relationToPerson(person, { author: me, recipients: [me], observer: me }), "sent");
  assert.equal(relationToPerson(person, { recipients: [me], observer: me }), "received");
  assert.equal(relationToPerson(person, { observer: me }), "observed");
  for (const other of [{ ...me, scope: "cli_other" }, { ...me, provider: "other" }, { ...me, id: "ou_other" }]) {
    assert.equal(relationToPerson(person, { author: other, recipients: [other], observer: other }), undefined);
  }
  assert.equal(relationToPerson(person, {}), undefined);
  assert.throws(() => PersonSchema.parse({ name: "张三", identities: [me, me] }));
  assert.throws(() => PersonSchema.parse({ name: "张三", identities: [{ ...me, scope: "tenant-id" }] }));
  assert.throws(() => PersonSchema.parse({ name: "张三", identities: [{ ...me, id: "display name" }] }));
  assert.throws(() => PersonSchema.parse({ name: "张三", identities: [me], preferences: [] }));
});

test("Channel intake distinguishes the Person from the bot and never equates bot receipt with personal receipt", () => {
  const input = { channelId: "lark", observation: { provider: "lark", accountId: "cli_app",
    sender: { id: "ou_other", type: "user" }, mentions: ["ou_bot"], chatType: "p2p" } };
  assert.equal(channelRelation(person, input), undefined);
  assert.equal(channelRelation(person, { ...input, observation: { ...input.observation, mentions: ["ou_me"] } }), "received");
  assert.equal(channelRelation(person, { ...input, observation: { ...input.observation, sender: { id: "ou_me", type: "user" } } }), "sent");
  assert.equal(channelRelation(person, { ...input, observation: { ...input.observation, sender: { id: "ou_me", type: "app" } } }), undefined);
  assert.equal(channelRelation(person, { ...input, observation: { ...input.observation, accountId: "cli_other", mentions: ["ou_me"] } }), undefined);
  assert.equal(channelRelation(person, { channelId: "lark" }), undefined);
  assert.equal(channelRelation({ identities: [] }, { channelId: "web" }), "sent");
});

test("Input relation is validated, survives restart and reaches Chief's description with its evidence", (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-person-input-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  let store = new InputStore(home);
  const base = { origin: "channel" as const, originId: "lark", text: "my view", observation: { sender: me } };
  for (const relation of ["sent", "received", "observed"] as const) store.submit("test", relation, { ...base, relation });
  store.submit("test", "unknown", base);
  assert.throws(() => store.submit("test", "bad", { ...base, relation: "incoming" as "sent" }));
  store = new InputStore(home);
  for (const relation of ["sent", "received", "observed"] as const) {
    const input = store.get(relation)!;
    assert.equal(input.spec.relation, relation);
    assert.match(inputPrinter.describe(input), new RegExp(`Relation to Person: ${relation}`));
    assert.deepEqual(input.spec.observation, base.observation);
  }
  assert.equal(store.get("unknown")!.spec.relation, undefined);
  assert.doesNotMatch(inputPrinter.describe(store.get("unknown")!), /Relation to Person:/);
});

test("Lark sender evidence survives its durable inbox and Personal classifies it using shared bindings", { timeout: 20_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "aide-person-channel-"));
  const configFile = join(home, "config.yaml");
  writeFileSync(configFile, JSON.stringify({ channels: { work: { kind: "lark", label: "Work", enabled: true, appId: "cli_app", appSecret: "test-secret", me: { openId: "ou_me" } } } }));
  const prompts: string[] = [];
  const log = pino({ level: "silent" });
  const aide = new Aide(home, { ...fakeOptions({ async chief() { return "ok"; }, async execute() { throw new Error("No work expected"); } }, home, prompts), config: loadConfig(configFile) }, log);
  const transport = { async start() {}, close() {}, async chatName() { return undefined; }, async send() {} };
  let channel = new LarkChannel(home, "cli_app", aide, transport, log);
  t.after(async () => { await channel.close(); await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const event = (id: string, userId: string) => ({ sender: { sender_type: "user", sender_id: { open_id: userId } },
    message: { message_id: id, chat_id: "oc_chat", chat_type: "p2p", message_type: "text", content: JSON.stringify({ text: id }) } });
  await channel.receive(event("mine", "ou_me"));
  await channel.receive(event("other", "ou_other"));
  await channel.close(); channel = new LarkChannel(home, "cli_app", aide, transport, log);
  await channel.dispatch(); await aide.settled();
  const inputs = aide.personal.topics.inputStore.list();
  assert.equal(inputs.find((input) => input.spec.text === "mine")!.spec.relation, "sent");
  assert.equal(inputs.find((input) => input.spec.text === "other")!.spec.relation, undefined);
  const self = (await aide.persons.findIdentity(me))!;
  assert.equal(inputs.find((input) => input.spec.text === "mine")!.spec.sender!.uid, self.metadata.uid);
  const other = inputs.find((input) => input.spec.text === "other")!.spec.sender!;
  assert.equal((await aide.persons.read(other.name)).isMe, false);
  assert.deepEqual(inputs.find((input) => input.spec.text === "mine")!.spec.observation!.sender, { id: "ou_me", type: "user" });
  assert.ok(prompts.some((prompt) => prompt.includes("Relation to Person: sent")));
  // New arrivals retain attribution; the adapter owns previous native history.

  await channel.receive(event("followup", "ou_me"));
  await channel.dispatch(); await aide.settled();
  const history = prompts.at(-1)!;
  assert.match(history, /Relation to Person: sent/);
  assert.doesNotMatch(history, /Text:\nother/);
  assert.match(history, /Origin: channel/);
});

test("Configured Forge Me accounts join the same Person without marking the execution account", async t => {
  const { emptyConnectors } = await import("../src/connector-client.ts");
  const { forgeCatalog } = await import("../connectors/forge/catalog.ts");
  const home = mkdtempSync(join(tmpdir(), "aide-forge-me-"));
  const descriptions = [
    { kind: "forge", version: "v1", name: "github-connection", revision: "github-r1", methods: [], metadata: { provider: "github", forge: "github.example", me: { username: "human" } } },
    { kind: "forge", version: "v1", name: "codebase-connection", revision: "codebase-r1", methods: [], metadata: { provider: "codebase", forge: "code.byted.org", me: { username: "human.work" } } },
    { kind: "forge", version: "v1", name: "unmarked", revision: "r1", methods: [], metadata: { provider: "github", forge: "unmarked.example" } },
  ];
  const aide = new Aide(home, { ...fakeOptions({ async execute() { throw new Error("No Work"); } }, home),
    connectors: emptyConnectors, connectorCatalog: descriptions }, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const operator = await aide.persons.observe({ provider: "github", scope: "github.example", id: "operator" }, "Execution account");
  await aide.start();
  const github = await aide.persons.findIdentity({ provider: "github", scope: "github.example", id: "human" });
  const codebase = await aide.persons.findIdentity({ provider: "codebase", scope: "code.byted.org", id: "human.work" });
  assert.ok(github && codebase);
  assert.equal(github.metadata.uid, codebase.metadata.uid);
  assert.equal(github.isMe, true);
  assert.equal((await aide.persons.read(operator.metadata.name)).isMe, false);
  assert.equal((await aide.persons.list()).filter(p => p.isMe).length, 1);
  assert.throws(() => forgeCatalog([{ ...descriptions[0]!, metadata: { ...descriptions[0]!.metadata, me: { username: "" } } }]));
});
