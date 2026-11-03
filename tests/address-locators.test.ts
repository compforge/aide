import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { KeyedSet } from "@compforge/ts-stdx/collections";
import definitions from "../plugins/personal/definitions.ts";
import { ResourceStorage } from "../src/host/resource/storage.ts";
import { Addresses } from "../plugins/personal/address/service.ts";
import { AddressCoordinator } from "../plugins/personal/address/coordinator.ts";
import { ADDRESS_TYPE, AddressSpecSchema, addressRef, addressRefs, locators, type AddressRef } from "../plugins/personal/address/model.ts";
import { PERSON_TYPE, personRef } from "../plugins/personal/person/model.ts";
import { openPersonCatalog } from "../plugins/personal/person/catalog.ts";
import { assertChannelDelivery, larkAddress, larkPersonAddress, larkThreadAddress } from "../src/channel/address.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { OUTPUT_TYPE, type Output } from "../plugins/personal/output/model.ts";
import { NOTE_TYPE, type NoteResource } from "../plugins/personal/note/model.ts";
import { summaryText } from "../plugins/personal/note/summary.ts";
import { TopicStore } from "./topic-fixture.ts";
import { composeMail } from "../plugins/personal/stream/writer.ts";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";

const log = pino({ level: "silent" }), app = "cli_one";
const identity = { provider: "lark", scope: app, id: "ou_alice" };
async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-locators-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  ResourceStorage.open(home).register("personal", definitions);
  const catalog = openPersonCatalog(home, { identities: [] }, log, () => {}, [app]);
  const person = await catalog.persons.observe(identity, "Alice"), addresses = new Addresses(home), inputs = new InputStore(home);
  const contact = addresses.find(larkPersonAddress(app, identity.id))!;
  const chat = larkAddress(app, "oc_old");
  const original = addresses.observe(chat, [personRef(person)], { type: "direct", muted: true });
  const input = inputs.submit("topic", "request", { origin: "channel", originId: "lark", source: addressRef(original), sender: personRef(person), text: "original request",
    observation: { provider: "lark", accountId: app, chatId: "oc_old", chatType: "p2p", sender: { type: "user", id: identity.id } } });
  let selected = addressRef(contact);
  const coordinator = new AddressCoordinator(home, [app], log, (from, to) => { if (selected.uid === from.uid) selected = to; });
  return { ...catalog, home, person, addresses, inputs, contact, original, input, chat, coordinator, selected: () => selected,
    drain() { for (let i = 0; i < 20; i++) coordinator.reconcile(addressRef(original)); } };
}

test("Locators reject legacy fields and round trip as a canonical keyed set", () => {
  const a = larkAddress(app, "oc_old"), b = larkPersonAddress(app, identity.id);
  assert.equal(AddressSpecSchema.safeParse({ name: "DM", type: "direct", endpoint: a, aliases: [b] }).success, false);
  const parsed = AddressSpecSchema.parse({ name: "DM", type: "direct", muted: false, locators: [a, b] });
  assert.ok(parsed.locators instanceof KeyedSet);
  assert.deepEqual(parsed, AddressSpecSchema.parse({ ...parsed, locators: [b, a, b] }));
  assert.equal(parsed.locators.size, 2);
  assert.equal("endpoint" in parsed, false);
  assert.equal("aliases" in JSON.parse(JSON.stringify(parsed)), false);
});

test("Two separately discovered DM Addresses merge without losing admission, mute, current refs or historical identity", async t => {
  const f = await setup(t);
  const note = await f.addresses.client.create(NOTE_TYPE, { name: "matter", spec: { subject: personRef(f.person), addresses: addressRefs([addressRef(f.contact)]), text: "classified knowledge", sensitivity: "L2", visibility: "people" }, status: { updatedAt: new Date().toISOString() } });
  const topics = new TopicStore({ home: f.home, dir: f.home, id: "topic" });
  const topic = await topics.ensure("topic", larkPersonAddress(app, identity.id));
  assert.equal(topic.spec.address!.uid, f.contact.metadata.uid);
  f.drain();
  const survivor = f.addresses.read(addressRef(f.original));
  assert.equal(survivor.spec.locators.size, 2);
  assert.equal(survivor.spec.muted, true);
  assert.equal(f.addresses.find(larkPersonAddress(app, identity.id))!.metadata.uid, survivor.metadata.uid);
  assert.deepEqual([...f.addresses.read(addressRef(f.original)).status.people], [personRef(f.person)]);
  assert.deepEqual((await f.persons.read(f.person.metadata.name)).contacts.map(c => c.ref), [addressRef(survivor)]);
  assert.equal(topics.resource("topic")!.spec.address!.uid, survivor.metadata.uid);
  const moved = await f.client.get({ ...NOTE_TYPE, name: note.metadata.name, namespace: "v1" });
  assert.equal((moved!.spec as { text: string }).text, "classified knowledge");
  assert.deepEqual((moved!.spec as { addresses: unknown }).addresses, addressRefs([addressRef(survivor)]));
  assert.equal(f.selected().uid, survivor.metadata.uid);
  assert.equal(f.inputs.get("request")!.spec.source!.uid, f.original.metadata.uid);
  assert.ok(f.addresses.resources.get(ADDRESS_TYPE, f.contact.metadata.name).metadata.deletionTimestamp);
  f.addresses.resources.finalizeDeletion(ADDRESS_TYPE, f.contact.metadata.name);
  assert.throws(() => f.addresses.read(addressRef(f.contact)), /not found|no longer exists/i);
  assert.equal(f.addresses.resources.list(ADDRESS_TYPE).length, 1);
  assert.equal("redirectTo" in survivor.status, false);
  const outputs = new OutputStore(f.home, target => assertChannelDelivery(target, [app]));
  assert.deepEqual(outputs.destination({ spec: { target: addressRef(survivor), replyToMessageId: "om_reply" } } as Output), larkThreadAddress(app, "oc_old", "om_reply"));
});

test("Retiring Addresses wait for uncertain Outputs and resume the persisted merge after restart", async t => {
  const f = await setup(t), topics = new TopicStore({ home: f.home, dir: f.home, id: "topic" }), topic = await topics.ensure();
  const outputs = new OutputStore(f.home, target => assertChannelDelivery(target, [app]));
  const output = composeMail(outputs, "probe", "uncertain", { target: addressRef(f.contact), topic: { apiVersion: topic.apiVersion, kind: topic.kind, namespace: topic.metadata.namespace, name: topic.metadata.name, uid: topic.metadata.uid }, topicId: "topic", content: { kind: "text", text: "probe" } });
  outputs.update(output.metadata.name, s => ({ ...s, phase: "uncertain", attempts: 1 }));
  f.coordinator.reconcile(addressRef(f.original));
  const afterStart = f.addresses.read(addressRef(f.contact));
  assert.equal(afterStart.status.retiring, true);
  assert.equal(f.addresses.find(larkPersonAddress(app, identity.id))!.metadata.uid, f.original.metadata.uid);
  assert.deepEqual((await f.persons.read(f.person.metadata.name)).contacts.map(c => c.ref), [addressRef(f.original)]);
  const restarted = new AddressCoordinator(f.home, [app], log);
  assert.equal(restarted.reconcile(addressRef(f.original))?.requeueAfterMs, 5000);
  assert.equal(f.addresses.read(addressRef(f.contact)).metadata.uid, f.contact.metadata.uid);
  assert.throws(() => composeMail(outputs, "probe", "new", { target: addressRef(f.contact), topic: { apiVersion: topic.apiVersion, kind: topic.kind, namespace: topic.metadata.namespace, name: topic.metadata.name, uid: topic.metadata.uid }, topicId: "topic", content: { kind: "text", text: "new" } }), /merging/);
  outputs.failed(output.metadata.name, "explicitly resolved as not delivered");
  f.drain();
  assert.ok(f.addresses.resources.get(ADDRESS_TYPE, f.contact.metadata.name).metadata.deletionTimestamp);
  assert.equal(outputs.get(output.metadata.name)!.spec.target.uid, f.contact.metadata.uid);
});

test("Both classified summaries remain independently discoverable with original text and disclosure", async t => {
  const f = await setup(t);
  await f.addresses.summarize(addressRef(f.contact), "private understanding", f.addresses.view(addressRef(f.contact)).summaryVersion);
  await f.addresses.summarize(addressRef(f.original), "original understanding", f.addresses.view(addressRef(f.original)).summaryVersion);
  const oldSummary = f.addresses.view(addressRef(f.contact)).summaryNote!;
  f.drain();
  const copied = await f.client.get<NoteResource["spec"], NoteResource["status"]>({ ...NOTE_TYPE, name: oldSummary.id, namespace: "v1" });
  assert.equal(copied!.spec.text, "private understanding");
  assert.equal(copied!.spec.summaryOf!.uid, f.contact.metadata.uid);
  assert.equal(copied!.spec.sensitivity, oldSummary.sensitivity);
  assert.equal(copied!.spec.visibility, oldSummary.visibility);
  assert.equal(summaryText(f.addresses.resources, f.addresses.read(addressRef(f.original))), "original understanding");
  assert.ok(f.addresses.view(addressRef(f.original)).recent.some(n => n.uid === oldSummary.uid));
});

test("Source observations and another peer cannot establish bot DM equivalence", async t => {
  const f = await setup(t);
  const originalInput = f.inputs.get("request")!;
  // Use a different observed place with only Source evidence.
  const otherChat = f.addresses.observe(larkAddress(app, "oc_source"), [personRef(f.person)], { type: "direct" });
  f.inputs.submit("topic", "source-only", { ...originalInput.spec, origin: "source", source: addressRef(otherChat) });
  f.coordinator.reconcile(addressRef(otherChat));
  assert.equal(f.addresses.read(addressRef(otherChat)).spec.locators.size, 1);
  const b = await f.persons.observe({ ...identity, id: "ou_bob" });
  const conflict = f.addresses.observe(larkAddress(app, "oc_conflict"), [personRef(b)], { type: "direct" });
  f.inputs.submit("topic", "conflict", { origin: "channel", originId: "lark", source: addressRef(conflict), sender: personRef(b), text: "synthetic",
    observation: { provider: "lark", accountId: app, chatId: "oc_conflict", chatType: "p2p", sender: { type: "user", id: identity.id } } });
  f.coordinator.reconcile(addressRef(conflict));
  assert.equal(f.addresses.read(addressRef(conflict)).spec.locators.size, 1);
});

test("Real Channel admission succeeds when open_id and chat_id Addresses already coexist", { timeout: 20_000 }, async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-admission-locators-"));
  const options = fakeOptions({ async chief() { return "done"; }, async execute() { throw new Error("no work"); } }, home, [], home, app);
  options.config.channels.test!.me = { openId: identity.id };
  const aide = new Aide(home, options, log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.persons.initialize();
  const person = (await aide.persons.findIdentity(identity))!;
  const original = aide.addresses.observe(larkAddress(app, "oc_existing"), [personRef(person)], { type: "direct", muted: false });
  // Startup discovers open_id before the new p2p event reaches admission.
  await aide.start();
  assert.notEqual(aide.addresses.find(larkPersonAddress(app, identity.id))!.metadata.uid, original.metadata.uid);
  const receipt = await aide.receive({ id: "regression", channelId: "lark", topicKey: `lark:${app}:oc_existing`, source: larkAddress(app, "oc_existing"), text: "synthetic request", addressObservation: { type: "direct" },
    observation: { provider: "lark", accountId: app, chatId: "oc_existing", chatType: "p2p", sender: { type: "user", id: identity.id } } });
  assert.ok(aide.personal.topics.inputStore.get(receipt.inputId));
  await aide.settled();
  assert.equal(aide.addresses.find(larkPersonAddress(app, identity.id))!.metadata.uid, original.metadata.uid);
  const newcomer = await aide.receive({ id: "new-peer", channelId: "lark", topicKey: `lark:${app}:oc_new`, source: larkAddress(app, "oc_new"), text: "hello", addressObservation: { type: "direct" },
    observation: { provider: "lark", accountId: app, chatId: "oc_new", chatType: "p2p", sender: { type: "user", id: "ou_new" } } });
  assert.ok(aide.personal.topics.inputStore.get(newcomer.inputId));
  await aide.settled();
  const direct = aide.addresses.find(larkAddress(app, "oc_new"))!;
  assert.equal(direct.spec.muted, false);
  assert.equal(aide.addresses.find(larkPersonAddress(app, "ou_new"))!.metadata.uid, direct.metadata.uid);
});
