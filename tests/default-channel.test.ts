import { TASK_TYPE } from "../plugins/personal/task/model.ts";
import { LOCAL_ME, personRef } from "../plugins/personal/person/model.ts";
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
import { larkAddress, larkThreadAddress, larkPersonAddress } from "../src/channel/address.ts";
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
  assert.equal(original.spec.receivers?.[0]?.uid, (await aide.persons.findIdentity({ provider: "lark", scope: "cli_work", id: "ou_me" }))!.metadata.uid);
  assert.equal(aide.topics.inputs().length, 0);
  const sent: Array<{ to: string; type?: string; text: string }> = [];
  const channel = new LarkChannel(home, "cli_work", aide, { start: async () => {}, close() {}, async chatName() { return undefined; }, async send(to, text, _id, type) { sent.push({ to, text, type }); } }, log);
  await aide.reconcileOutput(notification.outputId);
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
  aide.topics.inputStore.update(input, { assess: { ...input.status.assess, completedAt: new Date().toISOString(), result: { summary: "done" } } });
  await aide.close();
  aide = new Aide(home, { ...options, config: { ...options.config, defaultChannel: "personal" } }, log);
  await aide.persons.initialize();
  assert.deepEqual(await aide.topics.say("group-topic", undefined, "尚未投递", undefined, { idempotencyKey: "pending" }), pending);
  assert.deepEqual(aide.outputStore.get(pending.outputId)!.spec.target, larkPersonAddress("cli_work", "ou_me"));
  const fresh = await aide.topics.say("group-topic", undefined, "新通知");
  assert.deepEqual(aide.outputStore.get(fresh.outputId)!.spec.target, larkPersonAddress("cli_personal", "ou_personal"));
  const personal = (await aide.persons.findIdentity({ provider: "lark", scope: "cli_personal", id: "ou_personal" }))!;
  assert.deepEqual(aide.outputStore.get(fresh.outputId)!.spec.receivers, [personRef(personal)]);
  assert.equal(personal.metadata.uid, original.spec.receivers![0]!.uid, "Both Channels contact the same Person using different accounts");
});

test("Me is optional for replies and must be resolved in the sending app's scope", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-channel-me-"));
  const cfg = config(); delete cfg.channels.work!.me;
  // An identity belonging to a different app cannot be substituted.
  cfg.connectors.lark = { kind: "messages", version: "v1", enabled: true, config: { timeoutMs: 15000, appId: "cli_connector", userId: "ou_observer", me: [{ appId: "cli_connector", openId: "ou_observer" }] } };
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

/** @case Marking an observed account as Me consolidates it into the existing Me without losing understanding or blocking startup. */
test("Configuring existing Persons as Channel Me consolidates their accounts without blocking startup", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-existing-me-"));
  const cfg = config(); delete cfg.channels.work!.me; delete cfg.channels.personal!.me;
  const options = fakeOptions({ async chief() { return "ok"; }, async execute() { throw new Error("No work"); } }, home);
  let aide = new Aide(home, { ...options, config: cfg }, log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.start();
  const identity = { provider: "lark", scope: "cli_work", id: "ou_me" };
  const observed = await aide.persons.observe(identity, "李乾坤");
  const person = await aide.persons.edit(observed.metadata.name, observed.metadata.uid, observed.metadata.resourceVersion, observed.spec, "用户修正的认识");
  const web = (await aide.persons.findIdentity(LOCAL_ME))!;
  const evidence = aide.topics.inputStore.submit("evidence", "earlier", { origin: "source", originId: "test", text: "此前的消息", sender: personRef(person) });
  await aide.close();
  aide = new Aide(home, { ...options, config: config() }, log);
  await aide.start();
  const marked = (await aide.persons.findIdentity(identity))!;
  assert.equal(marked.isMe, true);
  assert.equal(marked.metadata.uid, web.metadata.uid);
  assert.equal(marked.summaryText, person.summaryText);
  assert.equal((await aide.persons.list()).filter(p => p.isMe).length, 1);
  assert.deepEqual(aide.topics.inputStore.get(evidence.metadata.name)!.spec.sender, personRef(person));
  assert.equal((await aide.persons.findIdentity(LOCAL_ME))!.metadata.uid, web.metadata.uid);
  assert.ok(marked.spec.identities.some(i => i.scope === "cli_personal" && i.id === "ou_personal"));
  const output = await aide.topics.say("notice", undefined, "默认联系我");
  assert.deepEqual(aide.outputStore.get(output.outputId)!.spec.receivers, [personRef(marked)]);
  assert.deepEqual(aide.outputStore.get(output.outputId)!.spec.target, larkPersonAddress("cli_work", "ou_me"));
  await aide.close();
  // Connector knowledge alone neither selects the default recipient nor marks this Channel's sender as Me.
  const withoutMe = config(); delete withoutMe.channels.work!.me;
  withoutMe.connectors.lark = { kind: "messages", version: "v1", enabled: true, config: { timeoutMs: 15000, me: [{ appId: "cli_work", openId: "ou_me" }] } };
  aide = new Aide(home, { ...options, config: withoutMe }, log);
  await aide.start();
  await assert.rejects(aide.topics.say("notice", undefined, "没有渠道 Me"), /configure channels.work.me/);
  await aide.personal.receive({ id: "incoming", channelId: "lark", topicId: "message", text: "hello", source: larkAddress("cli_work", "oc_group"),
    observation: { provider: "lark", accountId: "cli_work", sender: { id: "ou_me", type: "user" }, mentions: [] } });
  const incoming = aide.topics.inputStore.list().find(i => i.spec.text === "hello")!;
  assert.equal(incoming.spec.relation, undefined);
  assert.equal(incoming.spec.sender!.uid, marked.metadata.uid);
  const reply = await aide.topics.say("message", undefined, "仍可回复原群", undefined, { respondToInputId: incoming.metadata.name });
  assert.deepEqual(aide.outputStore.get(reply.outputId)!.spec.target, larkAddress("cli_work", "oc_group"));
});


test("Shared say resolves Person identities by Channel, keeps Aide as sender and explicitly contacts Me", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-person-say-"));
  const aide = new Aide(home, { ...fakeOptions({ async execute() { throw new Error("No inference"); } }, home), config: config() }, log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.persons.initialize();
  const person = await aide.persons.observe({ provider: "lark", scope: "cli_work", id: "ou_colleague" }, "李阳");
  const to = { personId: person.metadata.name, uid: person.metadata.uid };
  const sent = await aide.topics.say("default", undefined, "我是 Aide，受托询问部署进展。", undefined, { to, channelId: "work", idempotencyKey: "question" });
  assert.deepEqual(aide.outputStore.get(sent.outputId)!.spec.target, larkPersonAddress("cli_work", "ou_colleague"));
  assert.deepEqual(aide.outputStore.get(sent.outputId)!.spec.receivers, [personRef(person)]);
  await assert.rejects(aide.topics.say("default", undefined, "bad", undefined, { to }), /requires channelId/);
  await assert.rejects(aide.topics.say("default", undefined, "bad", undefined, { to, channelId: "personal" }), /needs one Lark identity/);
  await assert.rejects(aide.topics.say("default", undefined, "bad", undefined, { to: { ...to, uid: "stale" }, channelId: "work" }), /Unknown Person/);
  await seedInput(aide.topics, "group-mention", { topicId: "default", origin: "channel", originId: "lark", source: larkAddress("cli_work", "oc_group"), text: "question" });
  const me = await aide.topics.say("default", "group-mention", "联系被服务者", undefined, { to: { me: true } });
  assert.deepEqual(aide.outputStore.get(me.outputId)!.spec.target, larkPersonAddress("cli_work", "ou_me"));
  const resources = aide.runtime.plugins.resourceClient("personal");
  await resources.delete(person, person.metadata.name, "v1");
  assert.deepEqual(await aide.topics.say("default", undefined, "我是 Aide，受托询问部署进展。", undefined, { to, channelId: "work", idempotencyKey: "question" }), sent);
  await assert.rejects(aide.topics.say("default", undefined, "new", undefined, { to, channelId: "work" }), /Unknown Person/);
});

test("Interrupted addressless work retains notification intent until Me can be resolved", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-recovery-notice-"));
  const options = { ...fakeOptions({ async execute() { throw new Error("No inference"); } }, home), config: config() };
  let aide = new Aide(home, options, log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const work = await aide.work("default").create({ kind: "task", title: "Verify", instruction: "Inspect", trigger: null });
  const interrupted = aide.personal.store.resources.get(TASK_TYPE, work.id);
  await aide.runtime.plugins.resourceClient("personal").patchStatus(interrupted, { execution: { id: "interrupted", startedAt: new Date().toISOString() } });
  await aide.personal.recoverInterrupted();
  assert.equal(aide.personal.store.get(work.id).status, "uncertain");
  const notice = aide.personal.store.get(work.id).recoveryNotice;
  assert.ok(notice);
  assert.equal(aide.outputs().length, 0);
  await aide.close();
  aide = new Aide(home, options, log);
  await aide.persons.initialize();
  await aide.personal.recoverInterrupted();
  assert.equal(aide.personal.store.get(work.id).recoveryNotice, null);
  assert.equal(aide.outputs().length, 1);
  assert.deepEqual(aide.outputs()[0]!.target, larkPersonAddress("cli_work", "ou_me"));
  // Simulate a crash after Output acceptance but before clearing the durable notice.
  await aide.personal.store.save({ ...aide.personal.store.get(work.id), recoveryNotice: notice });
  await aide.personal.recoverInterrupted();
  assert.equal(aide.outputs().length, 1);
});


test("Lark thread replies preserve the original message endpoint through Output delivery", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-thread-output-"));
  const aide = new Aide(home, { ...fakeOptions({ async execute() { throw new Error("No inference"); } }, home), config: config(), checkDisclosure: async () => ({ allowed: true, reason: "test support" }),
    destinationAudience: async () => ({ identities: [LOCAL_ME], complete: true, private: true }) }, log);
  await aide.persons.initialize();
  const calls: unknown[][] = [];
  const channel = new LarkChannel(home, "cli_work", aide, { start: async () => {}, close() {}, async chatName() { return undefined; }, async send(...args) { calls.push(args); } }, log);
  t.after(async () => { await channel.close(); await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const target = larkThreadAddress("cli_work", "oc_group", "om_original");
  await seedInput(aide.topics, "thread-input", { topicId: "thread", origin: "channel", originId: "lark", source: target, text: "question" });
  const receipt = await aide.topics.say("thread", "thread-input", "reply", undefined, { respondToInputId: "thread-input" });
  await aide.reconcileOutput(receipt.outputId);
  await channel.deliver();
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], "oc_group");
  assert.equal(calls[0]![4], "om_original");
  assert.equal(aide.outputStore.get(receipt.outputId)!.status.phase, "delivered");
});
