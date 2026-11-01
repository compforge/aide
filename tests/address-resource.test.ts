import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import pino from "pino";
import { Addresses } from "../plugins/personal/address/service.ts";
import { ADDRESS_TYPE, addressRef, addressRefs } from "../plugins/personal/address/model.ts";
import { personRefs, personRef, PERSON_TYPE, LOCAL_ME, type PersonResource } from "../plugins/personal/person/model.ts";
import { PersonDefinition } from "../plugins/personal/person/definition.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { NOTE_TYPE, noteVersion, type NoteResource } from "../plugins/personal/note/model.ts";
import { upsertNote } from "../plugins/personal/note/service.ts";
import { contentVersion } from "../plugins/personal/context-write.ts";
import { writeSummary } from "../plugins/personal/note/summary.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { larkAddress, larkThreadAddress, webAddress, larkEndpoint } from "../src/channel/address.ts";
import { TopicStore, seedInput } from "./topic-fixture.ts";
import { OutputDisclosure } from "../plugins/personal/output/disclosure.ts";
import { OutputDelivery } from "../plugins/personal/output/delivery.ts";
import { outputSpec } from "../plugins/personal/output.ts";
import { replyIdentity } from "../plugins/personal/address/reply.ts";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { httpChannel } from "../src/api/index.ts";

const log = pino({ level: "silent" }), group = larkAddress("app", "group");
async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-places-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const topics = new TopicStore({ home, dir: home, id: "test" }), addresses = new Addresses(home);
  addresses.resources.storage.register("personal", [PersonDefinition]);
  const people = await Promise.all(["me", "a", "b"].map(name => addresses.client.create(PERSON_TYPE, {
    name, spec: { name, identities: name === "me" ? [LOCAL_ME] : [], clearance: "L1" },
    status: { updatedAt: new Date().toISOString(), updatedBy: "user" },
  }))) as PersonResource[];
  const [me, a, b] = people as [PersonResource, PersonResource, PersonResource];
  const topic = await topics.ensure("test");
  const store = topics.outputStore;
  const checker = new OutputDisclosure(store, { marks: { identities: [LOCAL_ME] },
    audience: async endpoint => {
      const address = addresses.observe(endpoint, endpoint.kind === "channel" && (endpoint as { channelId?: string }).channelId === "web" ? [personRef(me)] : []);
      return { people: [...address.status.people].map(ref => people.find(p => p.metadata.uid === ref.uid)!), private: address.spec.type === "web" || address.spec.type === "direct", muted: address.spec.muted };
    }, contactMe: async () => ({ target: webAddress("test"), receivers: [personRef(me)] }), check: async () => ({ allowed: true, reason: "Supported by cited Notes" }) }, log);
  store.check = id => checker.reconcile(id);
  return { home, topics, addresses, me, a, b, topic, store, checker };
}

test("Address discovery unifies threads and accumulates known people without overriding mute or summary", async t => {
  const f = await setup(t), inputs = new InputStore(f.home);
  inputs.submit("test", "one", { origin: "source", originId: "personal.lark", source: group, sender: personRef(f.a), text: "one" });
  const first = inputs.get("one")!.spec.source!, original = f.addresses.read(first);
  assert.equal(original.spec.muted, true);
  f.addresses.setMuted(first, false, true);
  await f.addresses.summarize(first, "发布协调场合", contentVersion(original));
  inputs.submit("test", "two", { origin: "channel", originId: "lark", source: larkThreadAddress("app", "group", "message"), sender: personRef(f.b), text: "two" });
  assert.deepEqual(inputs.get("two")!.spec.source, first);
  const current = f.addresses.read(first);
  assert.equal(current.spec.muted, false);
  assert.equal(current.status.people.size, 2);
  assert.equal(f.addresses.view(first).summaryText, "发布协调场合");
  assert.equal(inputs.get("two")!.spec.replyToMessageId, "message");
  assert.throws(() => f.addresses.setMuted(first, true, true), /test|conflict/i);
});

test("Address summary uses a protected Note and recent address association preserves matter ownership", async t => {
  const f = await setup(t), place = f.addresses.observe(group, [personRef(f.a)]), ref = addressRef(place);
  const actor = await f.addresses.client.patchStatus(f.topic, { execution: { id: "chief", startedAt: new Date().toISOString() } });
  const writer = { resource: { ...resourceRef(actor), kind: "Topic" as const, namespace: "v1" as const }, executionId: "chief" };
  await writeSummary(f.addresses.client, place, { text: "讨论发布风险", people: [personRef(f.a)], sensitivity: "L1", visibility: "people" }, writer);
  const view = f.addresses.view(ref);
  assert.equal(view.summaryNote!.summaryOf!.kind, "Address");
  const summary = f.addresses.resources.get<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, view.summaryNote!.id);
  assert.equal(f.addresses.resources.storage.definition("personal", NOTE_TYPE).retention!.canEvict!(summary, { get: () => place } as never), false);
  const note = await upsertNote(f.addresses.client, actor, { text: "今天等待验证结论", addresses: [ref], sensitivity: "L1", visibility: "any" }, "matter");
  const matter = f.addresses.resources.get<NoteResource["spec"], NoteResource["status"]>(NOTE_TYPE, note.noteId);
  assert.equal(matter.spec.subject.uid, actor.metadata.uid);
  assert.equal((await f.addresses.recent(ref)).items[0]!.id, note.noteId);
  assert.equal(f.addresses.read(ref).spec.muted, true, "Agent knowledge edits cannot unmute the place");
});

test("Unmuted group checks all known people; late mute privately redirects the unsent Output", async t => {
  const f = await setup(t), place = f.addresses.observe(group, [personRef(f.a)]), ref = addressRef(place);
  f.addresses.setMuted(ref, false, true);
  const note = await f.addresses.client.create(NOTE_TYPE, { name: "evidence", spec: { subject: resourceRef(f.topic), text: "公开进展", people: personRefs([personRef(f.a)]), addresses: addressRefs([]), sensitivity: "L1", visibility: "people" }, status: { updatedAt: new Date().toISOString() } }) as NoteResource;
  const create = (id: string) => f.store.create("test", id, outputSpec(f.topic, { topicId: "test", text: "公开进展", target: group }, { notes: [{ uid: note.metadata.uid, version: noteVersion(note) }] }));
  create("one"); await f.checker.reconcile("one"); assert.equal(f.store.get("one")!.status.disclosure!.decision, "allowed");
  f.addresses.observe(group, [personRef(f.b)]);
  await f.checker.reconcile("one"); assert.equal(f.store.get("one")!.status.disclosure!.decision, "denied");
  assert.match(f.store.get("one")!.status.disclosure!.reason, /outside visibility/);
  create("muted"); f.addresses.setMuted(ref, true, false);
  const sent: unknown[] = [];
  const delivery = new OutputDelivery(f.store, () => ({ replay: "idempotent", async send(message) { sent.push(message.target); return undefined; } }), log);
  await delivery.reconcile("muted");
  assert.deepEqual(sent, [webAddress("test")]);
  assert.match(f.store.get("muted")!.status.disclosure!.reason, /muted/);
});

test("Source and Channel mentions share one reply; explicit target remains Chief's choice", async t => {
  const f = await setup(t), observation = { provider: "lark", accountId: "app", kind: "mention", originalMessageId: "external-message", message: { id: "external-message", chatId: "group" } };
  await seedInput(f.topics, "source", { origin: "source", originId: "personal.lark", source: group, text: "问题", observation });
  await seedInput(f.topics, "channel", { origin: "channel", originId: "lark", source: group, text: "问题", observation: { provider: "lark", accountId: "app", chatId: "group", messageId: "external-message" } });
  assert.equal(replyIdentity(f.topics.inputStore.get("source")!)!.key, replyIdentity(f.topics.inputStore.get("channel")!)!.key);
  const [one, two] = await Promise.all([f.topics.say("test", "source", "答复", undefined, { respondToInputId: "source", target: webAddress("test") }), f.topics.say("test", "channel", "答复", undefined, { respondToInputId: "channel", target: webAddress("test") })]);
  assert.equal(one.outputId, two.outputId);
  assert.deepEqual(f.store.destination(f.store.get(one.outputId)!), webAddress("test"));
  assert.equal(f.store.list().length, 1);
});

test("An explicit Me reply cancels unsent reply but unrelated Me speech does not", async t => {
  const f = await setup(t);
  await seedInput(f.topics, "question", { origin: "source", originId: "personal.lark", source: group, text: "问题", observation: { provider: "lark", accountId: "app", kind: "mention", message: { id: "question", chatId: "group" } } });
  const receipt = await f.topics.say("test", "question", "答复", undefined, { respondToInputId: "question" });
  assert.equal(larkEndpoint(f.store.destination(f.store.get(receipt.outputId)!))!.replyToMessageId, "question");
  f.topics.inputStore.submit("test", "unrelated", { origin: "source", originId: "personal.lark", relation: "sent", source: group, text: "另一件事", observation: { provider: "lark", accountId: "app", message: { id: "other", chatId: "group" } } });
  assert.equal(f.store.get(receipt.outputId)!.status.phase, "pending");
  f.topics.inputStore.submit("test", "answered", { origin: "source", originId: "personal.lark", relation: "sent", source: group, text: "已经答了", observation: { provider: "lark", accountId: "app", message: { id: "answer", chatId: "group", parentId: "question" } } });
  let sends = 0;
  await new OutputDelivery(f.store, () => ({ replay: "idempotent", async send() { sends++; return undefined; } }), log).reconcile(receipt.outputId);
  assert.equal(f.store.get(receipt.outputId)!.status.phase, "cancelled"); assert.equal(sends, 0);
});

test("Address Web API edits muted and summary independently and exposes known participants", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-address-web-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected Work"); } }, home), log);
  const server = httpChannel(aide, log); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.start();
  const me = (await aide.persons.list()).find(p => p.isMe)!;
  const address = aide.addresses.observe(group, [personRef(me)], { name: "发布协调" });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const page = await (await fetch(base + "/addresses/list")).json(); assert.equal(page.items[0].name, "发布协调");
  const post = (path: string, value: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const result = await post("/addresses/muted", { address: addressRef(address), muted: false, expected: true }); assert.equal(result.status, 200);
  const view = await result.json(); assert.equal(view.spec.muted, false); assert.equal(view.participants[0].name, "我");
  const saved = await post("/addresses/summary", { address: addressRef(address), text: "讨论发布安排", version: view.summaryVersion });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).summaryText, "讨论发布安排");
  const html = await (await fetch(base + "/addresses")).text(); assert.match(html, /参与者/); assert.match(html, /禁言/);
});
