import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { KeyedSet } from "@compforge/ts-stdx/collections";
import { openPersonCatalog } from "../plugins/personal/person/catalog.ts";
import { PersonContacts } from "../plugins/personal/person/contacts.ts";
import { PERSON_TYPE, PersonSchema, personRef } from "../plugins/personal/person/model.ts";
import { reconcilePerson } from "../plugins/personal/person/reconcile.ts";
import { Addresses } from "../plugins/personal/address/service.ts";
import { ADDRESS_TYPE, addressRef, addressRefs } from "../plugins/personal/address/model.ts";
import { larkAddress, larkPersonAddress, larkThreadAddress } from "../src/channel/address.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import type { Output } from "../plugins/personal/output/model.ts";

const log = pino({ level: "silent" });
const identity = (id = "ou_alice", scope = "cli_one") => ({ provider: "lark", scope, id });
function setup(t: TestContext, apps = ["cli_one", "cli_two"]) {
  const home = mkdtempSync(join(tmpdir(), "aide-contacts-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const catalog = openPersonCatalog(home, { identities: [] }, log, () => {}, apps);
  return { ...catalog, home, addresses: new Addresses(home) };
}

test("Scoped human identities discover unmuted direct contacts only on enabled Channels", async t => {
  const f = setup(t);
  const a = await f.persons.observe(identity(), "Alice");
  const b = await f.persons.observe(identity("ou_alice", "cli_two"), "Alice");
  const unavailable = await f.persons.observe(identity("ou_other", "cli_disabled"));
  assert.equal(a.spec.addresses!.size, 1);
  assert.equal(b.spec.addresses!.size, 1);
  assert.equal(unavailable.spec.addresses!.size, 0);
  const ref = [...a.spec.addresses!][0]!;
  const address = f.addresses.read(ref);
  assert.equal(address.spec.muted, false);
  assert.deepEqual(address.spec.endpoint, larkPersonAddress("cli_one", "ou_alice"));
  assert.deepEqual([...address.status.people], [personRef(a)]);
  assert.notEqual(ref.uid, [...b.spec.addresses!][0]!.uid);
  const before = a.metadata.resourceVersion;
  assert.equal((await f.persons.observe(identity())).metadata.resourceVersion, before);
  f.addresses.setMuted(ref, true, false);
  f.contacts.ensure(a);
  assert.equal(f.addresses.read(ref).spec.muted, true);
  const view = await f.persons.read(a.metadata.name);
  assert.equal(view.contacts[0]!.ref.uid, ref.uid);
  assert.equal("muted" in view.contacts[0]! && view.contacts[0]!.muted, true);
});

test("Person addresses round trip as a UID keyed set with stable ordering", async t => {
  const f = setup(t), person = await f.persons.observe(identity());
  const other = f.addresses.observe(larkPersonAddress("cli_two", "ou_alice"), [personRef(person)], { type: "direct", muted: false });
  const refs = [...person.spec.addresses!, addressRef(other)];
  const parsed = PersonSchema.parse({ ...person.spec, addresses: [...refs].reverse().concat(refs) });
  assert.ok(parsed.addresses instanceof KeyedSet);
  assert.equal(parsed.addresses.size, 2);
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)).addresses, [...addressRefs(refs)]);
  const saved = await f.persons.edit(person.metadata.name, person.metadata.uid, person.metadata.resourceVersion, parsed);
  assert.ok(saved.spec.addresses instanceof KeyedSet);
  assert.deepEqual([...saved.spec.addresses!], [...parsed.addresses]);
  await assert.rejects(f.persons.edit(saved.metadata.name, saved.metadata.uid, saved.metadata.resourceVersion,
    { ...saved.spec, addresses: addressRefs([{ ...refs[0]!, uid: "stale" }]) }), /no longer exists/);
});

test("Bot p2p chat and open_id resolve one Address, including reply coordinates and mute", async t => {
  const f = setup(t), person = await f.persons.observe(identity());
  const ref = [...person.spec.addresses!][0]!, chat = larkAddress("cli_one", "oc_botdm");
  const bound = f.contacts.bindDirect(personRef(person), chat, "ou_alice");
  assert.equal(bound.metadata.uid, ref.uid);
  const input = new InputStore(f.home).submit("topic", "dm", { origin: "channel", originId: "lark", source: chat,
    sender: personRef(person), text: "Hi", addressObservation: { type: "direct" } });
  assert.equal(input.spec.source!.uid, ref.uid);
  assert.equal(f.addresses.observe(chat).metadata.uid, ref.uid);
  f.addresses.setMuted(ref, true, false);
  f.contacts.bindDirect(personRef(person), chat, "ou_alice");
  assert.equal(f.addresses.canSpeak(chat), false);
  const outputs = new OutputStore(f.home);
  assert.deepEqual(outputs.destination({ spec: { target: ref, replyToMessageId: "om_hi" } } as Output), larkThreadAddress("cli_one", "oc_botdm", "om_hi"));
  assert.equal(f.addresses.resources.list(ADDRESS_TYPE).length, 1);
  assert.throws(() => f.contacts.bindDirect(personRef(person), larkAddress("cli_two", "wrong"), "ou_alice"), /identified sender/);
});

test("Restart backfills existing people and reuses only proven bot DMs, retaining explicit mute", async t => {
  const f = setup(t, []), person = await f.persons.observe(identity());
  const chat = f.addresses.observe(larkAddress("cli_one", "oc_old"), [personRef(person)], { type: "direct", muted: true });
  new InputStore(f.home).submit("topic", "old-dm", { origin: "channel", originId: "lark", source: addressRef(chat), sender: personRef(person), text: "Hi", observation: { provider: "lark", accountId: "cli_one", sender: { type: "user", id: "ou_alice" } } });
  const restored = new PersonContacts(f.home, ["cli_one"], log).ensure(person);
  assert.deepEqual([...restored.spec.addresses!], [addressRef(chat)]);
  assert.equal(f.addresses.find(larkPersonAddress("cli_one", "ou_alice"))!.metadata.uid, chat.metadata.uid);
  assert.equal(f.addresses.read(addressRef(chat)).spec.muted, true);
  assert.equal(f.addresses.resources.list(ADDRESS_TYPE).length, 1);
});

test("A Connector-observed human DM is not a bot contact alias", async t => {
  const f = setup(t, []), person = await f.persons.observe(identity());
  const chat = f.addresses.observe(larkAddress("cli_one", "oc_humans"), [personRef(person)], { type: "direct" });
  new InputStore(f.home).submit("topic", "source-dm", { origin: "source", originId: "lark", source: addressRef(chat), sender: personRef(person), text: "Hi", observation: { provider: "lark", accountId: "cli_one", sender: { type: "user", id: "ou_alice" } } });
  const restored = new PersonContacts(f.home, ["cli_one"], log).ensure(person);
  assert.notEqual([...restored.spec.addresses!][0]!.uid, chat.metadata.uid);
  assert.equal(f.addresses.read(addressRef(chat)).spec.muted, true);
});

test("Person merge unions contacts and migrates reverse participants", async t => {
  const f = setup(t), a = await f.persons.observe(identity()), b = await f.persons.observe(identity("ou_bob", "cli_two"));
  const version = (p: typeof a) => ({ id: p.metadata.name, uid: p.metadata.uid, version: p.metadata.resourceVersion });
  const merged = await f.persons.merge(version(a), version(b));
  assert.equal(merged.spec.addresses!.size, 2);
  await reconcilePerson({ resources: f.client, logger: { info() {} } as never }, merged);
  for (const ref of merged.spec.addresses!) assert.deepEqual([...f.addresses.read(ref).status.people], [personRef(merged)]);
  assert.equal((await f.persons.observe(identity())).metadata.uid, b.metadata.uid);
});

test("Raw identity edits are completed by the same contacts reconciler and stale owners cannot write", async t => {
  const f = setup(t), person = await f.persons.observe(identity("ou_alice", "cli_disabled"));
  const edited = await f.client.replace(person, { ...person.spec, identities: [identity()] }, person.status);
  const completed = f.contacts.ensure(edited);
  assert.equal(completed.spec.addresses!.size, 1);
  await f.client.delete(PERSON_TYPE, completed.metadata.name, "v1", { uid: completed.metadata.uid, resourceVersion: completed.metadata.resourceVersion });
  assert.throws(() => f.contacts.ensure(person), /no longer exists/);
  const recreated = await f.client.get({ ...PERSON_TYPE, name: person.metadata.name, namespace: "v1" });
  assert.ok(recreated?.metadata.deletionTimestamp);
});


test("Conflicting chat ownership cannot overwrite an existing mute or bind another person's DM", async t => {
  const f = setup(t), a = await f.persons.observe(identity()), b = await f.persons.observe(identity("ou_bob"));
  const chat = larkAddress("cli_one", "oc_alice");
  const bound = f.contacts.bindDirect(personRef(a), chat, "ou_alice");
  f.addresses.setMuted(addressRef(bound), true, false);
  assert.throws(() => f.contacts.bindDirect(personRef(b), chat, "ou_bob"), /alias already belongs/);
  assert.equal(f.addresses.find(chat)!.metadata.uid, bound.metadata.uid);
  assert.equal(f.addresses.find(chat)!.spec.muted, true);
  assert.deepEqual([...f.addresses.find(chat)!.status.people], [personRef(a)]);
});
