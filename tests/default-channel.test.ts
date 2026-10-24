import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { ConfigSchema, loadConfig } from "../src/config.ts";
import { ChannelSettings, ChannelSettingsError } from "../src/channel/settings.ts";
import { larkAddress, larkPersonAddress } from "../src/channel/address.ts";
import { LarkChannel } from "../src/channel/lark/index.ts";
import { httpChannel } from "../src/api/index.ts";
import { fakeOptions } from "./fake-harness.ts";
import { seedInput } from "./topic-fixture.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";

const log = pino({ level: "silent" });
const bot = (appId = "cli_work", openId: string | undefined = "ou_me") => ({ kind: "lark" as const, label: "工作飞书", enabled: true, appId, appSecret: "private-secret", ...(openId ? { me: { openId } } : {}) });
const config = () => ConfigSchema.parse({ defaultChannel: "work", channels: { work: bot(), personal: bot("cli_personal", "ou_personal") }, plugins: { personal: { weave: { enabled: false } } } });

/** @case Default say reaches Me without any inbound message; explicit group replies and retries keep their exact destination. */
test("Default Channel contacts Me independently of Topic and preserves delivery through a default change", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-default-channel-"));
  const options = { ...fakeOptions({ async execute() { throw new Error("No work expected"); } }, home), config: config() };
  let aide = new Aide(home, options, log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.persons.initialize();
  const group = larkAddress("cli_work", "oc_group");
  await aide.topics.ensure("group-topic", group);
  const notification = await aide.topics.say("group-topic", undefined, "需要你关注", undefined, { idempotencyKey: "notice" });
  const original = aide.outputStore.get(notification.outputId)!;
  assert.deepEqual(original.spec.target, larkPersonAddress("cli_work", "ou_me"));
  assert.equal(original.spec.receivers?.[0]?.uid, (await aide.persons.me())!.metadata.uid);
  assert.equal(aide.topics.inputs().length, 0);
  const sent: Array<{ to: string; type?: string; text: string }> = [];
  const channel = new LarkChannel(home, "cli_work", aide, { start: async () => {}, close() {}, async send(to, text, _id, type) { sent.push({ to, text, type }); } }, log);
  await channel.deliver(); await channel.close();
  assert.deepEqual(sent, [{ to: "ou_me", type: "open_id", text: "需要你关注" }]);
  assert.equal(aide.outputStore.get(notification.outputId)!.status.phase, "delivered");
  const pending = await aide.topics.say("group-topic", undefined, "尚未投递", undefined, { idempotencyKey: "pending" });
  await aide.topics.ensure("default");
  await seedInput(aide.topics, "mention", { topicId: "group-topic", origin: "channel", originId: "lark", source: group, text: "@Aide 回复我" });
  assert.deepEqual(await aide.topics.say("group-topic", undefined, "尚未投递", undefined, { idempotencyKey: "pending" }), pending);
  assert.deepEqual(aide.outputStore.get(pending.outputId)!.spec.target, larkPersonAddress("cli_work", "ou_me"));
  const reply = await aide.topics.say("group-topic", undefined, "群内答复", undefined, { respondToInputId: "mention" });
  const immediate = await aide.topics.say("group-topic", undefined, "立即答复", undefined, { inputIds: ["mention"] });
  assert.deepEqual(aide.outputStore.get(reply.outputId)!.spec.target, group);
  assert.deepEqual(aide.outputStore.get(immediate.outputId)!.spec.target, group);
  // Mark assessment complete so the following notification is not another reply to the pending mention.
  const input = aide.topics.inputStore.get("mention")!, topic = aide.topics.resource("group-topic")!;
  aide.topics.inputStore.update(input, { assess: { [topic.metadata.uid]: { resource: resourceRef(topic), assignedAt: new Date().toISOString(), completedAt: new Date().toISOString(), result: { summary: "done" } } } });
  await aide.close();
  aide = new Aide(home, { ...options, config: { ...options.config, defaultChannel: "personal" } }, log);
  await aide.persons.initialize();
  assert.deepEqual(await aide.topics.say("group-topic", undefined, "尚未投递", undefined, { idempotencyKey: "pending" }), pending);
  assert.deepEqual(aide.outputStore.get(pending.outputId)!.spec.target, larkPersonAddress("cli_work", "ou_me"));
  const fresh = await aide.topics.say("group-topic", undefined, "新通知");
  assert.deepEqual(aide.outputStore.get(fresh.outputId)!.spec.target, larkPersonAddress("cli_personal", "ou_personal"));
});

test("Me is optional for replies and must be resolved in the sending app's scope", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-channel-me-"));
  const cfg = config(); delete cfg.channels.work!.me;
  // An identity belonging to a different app cannot be substituted.
  cfg.connectors.lark = { timeoutMs: 15000, appId: "cli_connector", userId: "ou_observer", me: [{ appId: "cli_connector", openId: "ou_observer" }] };
  const aide = new Aide(home, { ...fakeOptions({ async execute() { throw new Error("No work"); } }, home), config: cfg }, log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.persons.initialize();
  await assert.rejects(aide.topics.say("topic", undefined, "通知"), /needs Me's identity in app cli_work/);
  assert.equal(aide.outputs().length, 0);
  const reply = await aide.topics.say("topic", undefined, "原群回复", undefined, { target: larkAddress("cli_work", "oc_group") });
  assert.equal(aide.outputStore.get(reply.outputId)!.status.phase, "pending");
});

test("Channel settings redact secrets, detect stale edits and preserve unrelated YAML until restart", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-channel-settings-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, "config.yaml");
  writeFileSync(file, "# keep my comments\ndefaultHarness: pi\nplugins:\n  personal:\n    topic:\n      recentLimit: 10\n");
  const active = loadConfig(file), settings = new ChannelSettings(file, active, log);
  const initial = settings.snapshot();
  let view = settings.change({ operation: "save", revision: initial.revision, id: "work", channel: bot() });
  assert.equal(view.restartRequired, true); assert.equal(view.activeDefaultChannel, "web");
  assert.equal(JSON.stringify(view).includes("private-secret"), false);
  assert.equal(view.channels[0]!.secretConfigured, true);
  assert.throws(() => settings.change({ operation: "default", revision: initial.revision, id: "work" }), e => e instanceof ChannelSettingsError && e.status === 409);
  view = settings.change({ operation: "default", revision: view.revision, id: "work" });
  assert.equal(view.defaultChannel, "work"); assert.equal(active.defaultChannel, "web");
  const { appSecret, ...withoutSecret } = bot();
  view = settings.change({ operation: "save", revision: view.revision, id: "work", channel: { ...withoutSecret, label: "新名称" } });
  assert.equal(loadConfig(file).channels.work!.appSecret, appSecret);
  assert.throws(() => settings.change({ operation: "save", revision: view.revision, id: "work", channel: { ...withoutSecret, appId: "cli_other" } }), /App Secret/);
  assert.throws(() => settings.change({ operation: "save", revision: view.revision, id: "duplicate", channel: bot() }), /one Channel/);
  assert.throws(() => settings.change({ operation: "save", revision: view.revision, id: "work", channel: { ...withoutSecret, enabled: false } }), /enabled instance/);
  assert.throws(() => settings.change({ operation: "remove", revision: view.revision, id: "work" }), /enabled instance/);
  assert.ok(readFileSync(file, "utf8").startsWith("# keep my comments"));
  assert.deepEqual(loadConfig(file).plugins, active.plugins);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(new ChannelSettings(file, loadConfig(file), log).snapshot().restartRequired, false);
  view = settings.change({ operation: "default", revision: view.revision, id: "web" });
  view = settings.change({ operation: "save", revision: view.revision, id: "work", channel: { ...withoutSecret, enabled: false } });
  assert.equal(view.channels[0]!.enabled, false);
});

test("Channel page and API expose saved state without credentials", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-channel-api-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No work"); } }, home), log);
  const settings = new ChannelSettings(join(home, "config.yaml"), ConfigSchema.parse({}), log);
  const server = httpChannel(aide, log, settings);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await aide.close(); rmSync(home, { recursive: true, force: true }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  assert.match(await (await fetch(base + "/connections")).text(), /默认沟通渠道/);
  for (const asset of ["/connections.js", "/connections.css"]) assert.equal((await fetch(base + asset)).status, 200);
  const post = (path: string, value: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const response = await post("/channels/config", { operation: "save", revision: settings.snapshot().revision, id: "work", channel: bot() });
  assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /private-secret/);
});
