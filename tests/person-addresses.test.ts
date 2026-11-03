import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { openPersonCatalog } from "../plugins/personal/person/catalog.ts";
import { PersonContacts } from "../plugins/personal/person/contacts.ts";
import { PERSON_TYPE, PersonSchema, personRef } from "../plugins/personal/person/model.ts";
import { reconcilePerson } from "../plugins/personal/person/reconcile.ts";
import { Addresses } from "../plugins/personal/address/service.ts";
import { ADDRESS_TYPE, addressRef } from "../plugins/personal/address/model.ts";
import { larkAddress, larkPersonAddress } from "../src/channel/address.ts";
import { InputStore } from "../plugins/personal/input/store.ts";

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
  assert.equal((await f.persons.read(a.metadata.name)).contacts.length, 1);
  assert.equal((await f.persons.read(b.metadata.name)).contacts.length, 1);
  assert.equal((await f.persons.read(unavailable.metadata.name)).contacts.length, 0);
  const ref = (await f.persons.read(a.metadata.name)).contacts[0]!.ref;
  const address = f.addresses.read(ref);
  assert.equal(address.spec.muted, false);
  assert.deepEqual([...address.spec.locators], [larkPersonAddress("cli_one", "ou_alice")]);
  assert.deepEqual([...address.status.people], [personRef(a)]);
  assert.notEqual(ref.uid, (await f.persons.read(b.metadata.name)).contacts[0]!.ref.uid);
  const before = a.metadata.resourceVersion;
  assert.equal((await f.persons.observe(identity())).metadata.resourceVersion, before);
  f.addresses.setMuted(ref, true, false);
  f.contacts.ensure(a);
  assert.equal(f.addresses.read(ref).spec.muted, true);
  const view = await f.persons.read(a.metadata.name);
  assert.equal(view.contacts[0]!.ref.uid, ref.uid);
  assert.equal("muted" in view.contacts[0]! && view.contacts[0]!.muted, true);
});

test("Contacts are derived without Person writes; raw legacy addresses are rejected", async t => {
  const f = setup(t), person = await f.persons.observe(identity());
  assert.equal("addresses" in person.spec, false);
  assert.equal(PersonSchema.safeParse({ ...person.spec, addresses: [] }).success, false);
  const before = person.metadata.resourceVersion;
  const contact = f.addresses.find(larkPersonAddress("cli_one", "ou_alice"))!;
  // Merely sharing participants never makes a group or an unrelated direct chat a contact.
  f.addresses.observe(larkAddress("cli_one", "oc_group"), [personRef(person)]);
  f.addresses.observe(larkAddress("cli_one", "oc_unproven"), [personRef(person)], { type: "direct" });
  assert.deepEqual((await f.persons.read(person.metadata.name)).contacts.map(c => c.ref.uid), [contact.metadata.uid]);
  const updated = await f.client.replace(person, { ...person.spec, identities: [identity("ou_replaced")] }, person.status);
  assert.equal((await f.persons.read(person.metadata.name)).contacts.length, 0);
  f.contacts.ensure(updated);
  const view = await f.persons.read(person.metadata.name);
  assert.equal(view.contacts.length, 1);
  assert.notEqual(view.contacts[0]!.ref.uid, contact.metadata.uid);
  assert.notEqual(view.metadata.resourceVersion, before); // only the explicit identity edit wrote Person
  assert.equal(view.metadata.resourceVersion, updated.metadata.resourceVersion);
  f.addresses.resources.requestDeletion(ADDRESS_TYPE, view.contacts[0]!.ref.name);
  assert.equal((await f.persons.read(person.metadata.name)).contacts.length, 0);
});

test("A Connector-observed human DM is not a bot contact alias", async t => {
  const f = setup(t, []), person = await f.persons.observe(identity());
  const chat = f.addresses.observe(larkAddress("cli_one", "oc_humans"), [personRef(person)], { type: "direct" });
  new InputStore(f.home).submit("topic", "source-dm", { origin: "source", originId: "lark", source: addressRef(chat), sender: personRef(person), text: "Hi", observation: { provider: "lark", accountId: "cli_one", sender: { type: "user", id: "ou_alice" } } });
  new PersonContacts(f.home, ["cli_one"], log).ensure(person);
  assert.notEqual((await f.persons.read(person.metadata.name)).contacts[0]!.ref.uid, chat.metadata.uid);
  assert.equal(f.addresses.read(addressRef(chat)).spec.muted, true);
});

test("Person identity merge derives both contacts and migrates reverse participants", async t => {
  const f = setup(t), a = await f.persons.observe(identity()), b = await f.persons.observe(identity("ou_bob", "cli_two"));
  const version = (p: typeof a) => ({ id: p.metadata.name, uid: p.metadata.uid, version: p.metadata.resourceVersion });
  const merged = await f.persons.merge(version(a), version(b));
  assert.equal(merged.contacts.length, 2);
  await reconcilePerson({ resources: f.client, logger: { info() {} } as never }, merged);
  for (const { ref } of merged.contacts) assert.deepEqual([...f.addresses.read(ref).status.people], [personRef(merged)]);
  assert.equal((await f.persons.observe(identity())).metadata.uid, b.metadata.uid);
});

test("Raw identity edits are completed by the same contacts reconciler and stale owners cannot write", async t => {
  const f = setup(t), person = await f.persons.observe(identity("ou_alice", "cli_disabled"));
  const edited = await f.client.replace(person, { ...person.spec, identities: [identity()] }, person.status);
  const completed = f.contacts.ensure(edited);
  assert.equal((await f.persons.read(completed.metadata.name)).contacts.length, 1);
  await f.client.delete(PERSON_TYPE, completed.metadata.name, "v1", { uid: completed.metadata.uid, resourceVersion: completed.metadata.resourceVersion });
  assert.throws(() => f.contacts.ensure(person), /no longer exists/);
  const recreated = await f.client.get({ ...PERSON_TYPE, name: person.metadata.name, namespace: "v1" });
  assert.ok(recreated?.metadata.deletionTimestamp);
});
