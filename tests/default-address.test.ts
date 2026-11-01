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
import { larkAddress, larkPersonAddress, webAddress } from "../src/channel/address.ts";
import { httpChannel } from "../src/api/index.ts";
import { fakeOptions } from "./fake-harness.ts";
import { LOCAL_ME, personRef } from "../plugins/personal/person/model.ts";
import { addressRef } from "../plugins/personal/address/model.ts";
import { SayInputSchema } from "../plugins/personal/output/action.ts";

const log = pino({ level: "silent" });
const bot = (appId = "cli_work") => ({ kind: "lark" as const, label: "工作飞书", enabled: true, appId, appSecret: "private-secret", me: { openId: "ou_me" } });

/** @case Defaults select a concrete Me Address, while accepted Outputs retain the original incarnation through later configuration changes. */
test("Default Address is stable across Topics; changing it only affects new notifications", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-default-address-"));
  const config = ConfigSchema.parse({ channels: { work: bot() }, plugins: { personal: { weave: { enabled: false } } } });
  const aide = new Aide(home, { ...fakeOptions({ async execute() { throw new Error("No Work"); } }, home), config }, log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.start();
  const first = await aide.topics.say("one", undefined, "first", undefined, { idempotencyKey: "first" });
  const second = await aide.topics.say("two", undefined, "second");
  assert.deepEqual(aide.outputStore.get(first.outputId)!.spec.target, aide.outputStore.get(second.outputId)!.spec.target);
  assert.deepEqual(aide.outputStore.destination(aide.outputStore.get(first.outputId)!), webAddress("me"));
  const next = addressRef(aide.addresses.find(larkPersonAddress("cli_work", "ou_me"))!);
  await aide.validateDefaultAddress(next);
  config.defaultAddress = next;
  const third = await aide.topics.say("one", undefined, "third");
  assert.deepEqual(aide.outputStore.get(third.outputId)!.spec.target, next);
  assert.deepEqual(await aide.topics.say("one", undefined, "first", undefined, { idempotencyKey: "first" }), first);
  assert.deepEqual(aide.outputStore.destination(aide.outputStore.get(first.outputId)!), webAddress("me"));
  const group = addressRef(aide.addresses.observe(larkAddress("cli_work", "oc_group")));
  await assert.rejects(aide.validateDefaultAddress(group), /private/);
  const person = await aide.persons.observe({ provider: "lark", scope: "cli_work", id: "ou_other" }, "Other");
  const privateOther = addressRef(aide.addresses.observe(larkPersonAddress("cli_work", "ou_other"), [personRef(person)]));
  await assert.rejects(aide.validateDefaultAddress(privateOther), /private/);
  await assert.rejects(aide.validateDefaultAddress({ ...next, uid: "stale" }), /Address/);
  assert.equal(SayInputSchema.safeParse({ text: "hello", target: larkAddress("cli_work", "oc_group") }).success, false);
  assert.equal(SayInputSchema.safeParse({ text: "hello", to: { personId: person.metadata.name, uid: person.metadata.uid }, channelId: "work" }).success, false);
});

test("Channel settings preserve write-only credentials and YAML while default Address applies immediately", t => {
  const home = mkdtempSync(join(tmpdir(), "aide-channel-settings-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const file = join(home, "config.yaml");
  writeFileSync(file, "# keep comments\ndefaultHarness: pi\nplugins:\n  personal:\n    topic:\n      recentLimit: 10\n");
  const active = loadConfig(file), settings = new ChannelSettings(file, active, log);
  const initial = settings.snapshot();
  let view = settings.change({ operation: "save", revision: initial.revision, id: "work", channel: bot() });
  assert.equal(view.restartRequired, true);
  assert.equal(JSON.stringify(view).includes("private-secret"), false);
  assert.equal(view.channels[0]!.secretConfigured, true);
  const address = { apiVersion: "aide.dev/v1alpha1", kind: "Address", namespace: "v1", name: "test", uid: "test" } as const;
  assert.throws(() => settings.change({ operation: "default", revision: initial.revision, address }), e => e instanceof ChannelSettingsError && e.status === 409);
  view = settings.change({ operation: "default", revision: view.revision, address });
  assert.deepEqual(view.defaultAddress, address); assert.deepEqual(active.defaultAddress, address);
  const { appSecret, ...withoutSecret } = bot();
  view = settings.change({ operation: "save", revision: view.revision, id: "work", channel: { ...withoutSecret, label: "改名" } });
  assert.equal(loadConfig(file).channels.work!.appSecret, appSecret);
  assert.throws(() => settings.change({ operation: "save", revision: view.revision, id: "work", channel: { ...withoutSecret, appId: "cli_other" } }), /App Secret/);
  assert.throws(() => settings.change({ operation: "save", revision: view.revision, id: "duplicate", channel: bot() }), /one Channel/);
  assert.ok(readFileSync(file, "utf8").startsWith("# keep comments"));
  assert.deepEqual(loadConfig(file).plugins, active.plugins);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(new ChannelSettings(file, loadConfig(file), log).snapshot().restartRequired, false);
  assert.equal(ConfigSchema.safeParse({ defaultChannel: "web" }).success, false);
});

test("Addresses owns connection settings and validates default destinations through the API", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-address-api-"));
  const options = fakeOptions({ async execute() { throw new Error("No Work"); } }, home);
  const aide = new Aide(home, options, log);
  const settings = new ChannelSettings(join(home, "config.yaml"), options.config, log);
  const server = httpChannel(aide, log, settings);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await aide.close(); rmSync(home, { recursive: true, force: true }); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const socket = server.address(); assert.ok(socket && typeof socket !== "string");
  const base = `http://127.0.0.1:${socket.port}`;
  const html = await (await fetch(base + "/addresses")).text();
  assert.match(html, /接入管理/); assert.match(html, /设为默认通知地址/); assert.doesNotMatch(html, /href="\/connections"/);
  for (const asset of ["/addresses.js", "/addresses.css"]) assert.equal((await fetch(base + asset)).status, 200);
  assert.equal((await fetch(base + "/connections")).status, 404);
  const post = (value: unknown) => fetch(base + "/channels/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const response = await post({ operation: "save", revision: settings.snapshot().revision, id: "work", channel: bot() });
  assert.equal(response.status, 200); assert.doesNotMatch(await response.text(), /private-secret/);
  const snapshot = await (await fetch(base + "/channels/config")).json();
  assert.deepEqual(snapshot.defaultAddress, aide.defaultAddress());
  const group = addressRef(aide.addresses.observe(larkAddress("cli_work", "oc_group")));
  assert.equal((await post({ operation: "default", revision: snapshot.revision, address: group })).status, 400);
  assert.equal((await post({ operation: "default", revision: snapshot.revision, address: aide.defaultAddress() })).status, 200);
  assert.deepEqual(loadConfig(join(home, "config.yaml")).defaultAddress, aide.defaultAddress());
});

const config = () => ConfigSchema.parse({ channels: { work: bot(), personal: bot("cli_personal") }, plugins: { personal: { weave: { enabled: false } } } });
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
  assert.ok(marked.spec.identities.some(i => i.scope === "cli_personal" && i.id === "ou_me"));
  const output = await aide.topics.say("notice", undefined, "默认联系我");
  assert.deepEqual(aide.outputStore.get(output.outputId)!.spec.receivers?.toJSON(), [personRef(marked)]);
  assert.deepEqual(aide.outputStore.destination(aide.outputStore.get(output.outputId)!), webAddress("me"));
  await aide.close();
  // Connector knowledge alone neither selects the default recipient nor marks this Channel's sender as Me.
  const withoutMe = config(); delete withoutMe.channels.work!.me;
  withoutMe.connectors.lark = { kind: "messages", version: "v1", enabled: true, config: { timeoutMs: 15000, me: [{ appId: "cli_work", openId: "ou_me" }] } };
  aide = new Aide(home, { ...options, config: withoutMe }, log);
  await aide.start();
  const local = await aide.topics.say("notice", undefined, "默认本地通知");
  assert.deepEqual(aide.outputStore.destination(aide.outputStore.get(local.outputId)!), webAddress("me"));
  await aide.personal.receive({ id: "incoming", channelId: "lark", topicId: "message", text: "hello", source: larkAddress("cli_work", "oc_group"),
    observation: { provider: "lark", accountId: "cli_work", sender: { id: "ou_me", type: "user" }, mentions: [] } });
  const incoming = aide.topics.inputStore.list().find(i => i.spec.text === "hello")!;
  assert.equal(incoming.spec.relation, undefined);
  assert.equal(incoming.spec.sender!.uid, marked.metadata.uid);
  const reply = await aide.topics.say("message", undefined, "仍可回复原群", undefined, { respondToInputId: incoming.metadata.name });
  assert.deepEqual(aide.outputStore.destination(aide.outputStore.get(reply.outputId)!), larkAddress("cli_work", "oc_group"));
});


