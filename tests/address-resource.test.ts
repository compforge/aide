import { readAgentStream } from "../src/stream/agent.ts";
import { composeMail, mailView } from "../plugins/personal/stream/writer.ts";
import { addressFor } from "./address-fixture.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import pino from "pino";
import { Addresses } from "../plugins/personal/address/service.ts";
import { addressTools } from "../plugins/personal/address/tools.ts";
import { ADDRESS_TYPE, addressRef, addressRefs } from "../plugins/personal/address/model.ts";
import { personRefs, personRef, PERSON_TYPE, LOCAL_ME, type PersonResource } from "../plugins/personal/person/model.ts";
import { PersonDefinition } from "../plugins/personal/person/definition.ts";
import { InputAttention } from "../plugins/personal/input/model.ts";
import { DeliveryError } from "@compforge/aide-connector";
import { MUTED_OUTPUT_TEXT } from "../plugins/personal/stream/notices.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { NOTE_TYPE, noteVersion, type NoteResource } from "../plugins/personal/note/model.ts";
import { upsertNote } from "../plugins/personal/note/service.ts";
import { contentVersion } from "../plugins/personal/context-write.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { larkAddress, larkThreadAddress, webAddress, larkEndpoint } from "../src/channel/address.ts";
import { TopicStore, seedInput } from "./topic-fixture.ts";
import { OutputDisclosure } from "../plugins/personal/output/disclosure.ts";
import { OutputDelivery } from "../plugins/personal/output/delivery.ts";
import { mailDraft } from "../plugins/personal/output.ts";
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
    audience: async ref => {
      const address = addresses.read(ref);
      return { people: [...address.status.people].map(ref => people.find(p => p.metadata.uid === ref.uid)!), private: address.spec.type === "web" || address.spec.type === "direct", muted: address.spec.muted };
    }, contactMe: async () => ({ address: addressRef(addresses.observe(webAddress("test"), [personRef(me)])), target: webAddress("test"), receivers: [personRef(me)] }) }, log);
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
  inputs.submit("test", "two", { origin: "channel", originId: "lark", source: group, replyToMessageId: "message", sender: personRef(f.b), text: "two" });
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
  const summarize = addressTools(f.addresses, () => actor).find(tool => tool.name === "summarize_address")!;
  await summarize.execute("summary", { address: ref, version: contentVersion(place), text: "讨论发布风险", people: [personRef(f.a)], sensitivity: "L1", visibility: "people" }, undefined, undefined, {} as never);
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
  const create = (id: string) => composeMail(f.store, "test", id, mailDraft(f.topic, { topicId: "test", text: "公开进展", target: group }, { notes: [{ uid: note.metadata.uid, version: noteVersion(note) }] }));
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

test("Muted Output uses pinned Input attention to choose an original-address notice or default-address fallback", async t => {
  const f = await setup(t), inputs = new InputStore(f.home);
  const place = f.addresses.observe(group, [personRef(f.a)]), ref = addressRef(place);
  const cases = [
    { id: "channel-default", origin: "channel" as const, notice: true },
    { id: "source-immediate", origin: "source" as const, attention: InputAttention.Immediate, notice: true },
    { id: "channel-normal", origin: "channel" as const, attention: InputAttention.Normal, notice: false },
    { id: "source-normal", origin: "source" as const, notice: false },
    { id: "deferred", origin: "channel" as const, attention: InputAttention.Deferred, notice: false },
    { id: "stale-uid", origin: "channel" as const, notice: false },
    { id: "no-input", origin: "channel" as const, notice: false },
  ];
  for (const item of cases) {
    inputs.submit("test", item.id, { origin: item.origin, originId: "test", attention: item.attention, source: group, text: "问题" });
    const input = inputs.get(item.id)!;
    const raw = "原始隐私正文";
    composeMail(f.store, "test", item.id, mailDraft(f.topic, { topicId: "test", text: raw, target: group }, {
      ...(item.id === "no-input" ? {} : { inputIds: [item.id], inputUids: { [item.id]: item.id === "stale-uid" ? "deleted-input-uid" : input.metadata.uid } }),
      replyToMessageId: "original-message",
    }));
    const sent: import("../plugins/personal/output/delivery.ts").OutputMessage[] = [];
    const reconcile = new OutputDelivery(f.store, () => ({ replay: "idempotent", async send(message) { sent.push(message); return undefined; } }), log);
    await reconcile.reconcile(item.id); await reconcile.reconcile(item.id);
    assert.equal(sent.length, 1, item.id);
    assert.deepEqual(sent[0]!.target, item.notice ? larkThreadAddress("app", "group", "original-message") : webAddress("test"), item.id);
    assert.equal(sent[0]!.permitMuted, item.notice, item.id);
    if (item.notice) assert.equal(readAgentStream(sent[0]!.stream).text, MUTED_OUTPUT_TEXT);
    else { assert.match(readAgentStream(sent[0]!.stream).text, /原始隐私正文/); }
    const output = f.store.get(item.id)!;
    assert.equal(mailView(f.store, output).text, raw); assert.equal(output.spec.target.uid, ref.uid);
    assert.equal(output.status.phase, "delivered"); assert.equal(output.status.disclosure!.decision, "denied");
    assert.equal(f.addresses.read(ref).spec.muted, true);
  }
});

test("An Immediate mute notice remains fixed through retry, Input loss and unmute", async t => {
  const f = await setup(t), inputs = new InputStore(f.home);
  const ref = addressRef(f.addresses.observe(group, [personRef(f.a)]));
  inputs.submit("test", "immediate", { origin: "channel", originId: "test", source: group, text: "问题" });
  const input = inputs.get("immediate")!;
  composeMail(f.store, "test", "retry-notice", mailDraft(f.topic, { topicId: "test", text: "不能泄露的原文", target: group }, {
    inputIds: ["immediate"], inputUids: { immediate: input.metadata.uid },
  }));
  const sent: import("../plugins/personal/output/delivery.ts").OutputMessage[] = [];
  const transport = { replay: "idempotent" as const, async send(message: import("../plugins/personal/output/delivery.ts").OutputMessage) {
    sent.push(message);
    if (sent.length === 1) throw new DeliveryError({ kind: "retryable", message: "limited", retryAfterMs: 0 });
    return undefined;
  } };
  await new OutputDelivery(f.store, () => transport, log).reconcile("retry-notice");
  assert.equal(f.store.get("retry-notice")!.status.phase, "pending");
  // Once fixed, the notice no longer depends on the Input's lifetime or a later unmute.
  f.store.storage.db.prepare("DELETE FROM resources WHERE key=?").run(inputs.resources.key(input, input.metadata.name));
  f.addresses.setMuted(ref, false, true);
  const recovered = new OutputDelivery(f.store, () => transport, log);
  await recovered.reconcile("retry-notice"); await recovered.reconcile("retry-notice");
  assert.equal(sent.length, 2); assert.deepEqual(readAgentStream(sent[0]!.stream), readAgentStream(sent[1]!.stream));
  assert.equal(readAgentStream(sent[1]!.stream).text, MUTED_OUTPUT_TEXT); assert.deepEqual(sent[1]!.target, group);
  assert.equal(f.store.get("retry-notice")!.status.phase, "delivered");
  assert.equal(mailView(f.store, f.store.get("retry-notice")!).text, "不能泄露的原文");
});

test("Source and Channel mentions share one reply; explicit target remains Chief's choice", async t => {
  const f = await setup(t), observation = { provider: "lark", accountId: "app", kind: "mention", originalMessageId: "external-message", message: { id: "external-message", chatId: "group" } };
  await seedInput(f.topics, "source", { origin: "source", originId: "personal.lark", source: group, text: "问题", observation });
  await seedInput(f.topics, "channel", { origin: "channel", originId: "lark", source: group, text: "问题", observation: { provider: "lark", accountId: "app", chatId: "group", messageId: "external-message" } });
  assert.equal(replyIdentity(f.topics.inputStore.get("source")!)!.key, replyIdentity(f.topics.inputStore.get("channel")!)!.key);
  const [one, two] = await Promise.all([f.topics.say("test", "source", "答复", undefined, { respondToInputId: "source", target: addressFor(f.home, webAddress("test")) }), f.topics.say("test", "channel", "答复", undefined, { respondToInputId: "channel", target: addressFor(f.home, webAddress("test")) })]);
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
  const page = await (await fetch(base + "/addresses/list")).json(); assert.ok(page.items.some((item: { name: string }) => item.name === "发布协调"));
  const post = (path: string, value: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) });
  const result = await post("/addresses/muted", { address: addressRef(address), muted: false, expected: true }); assert.equal(result.status, 200);
  const view = await result.json(); assert.equal(view.spec.muted, false); assert.equal(view.participants[0].name, "我");
  const saved = await post("/addresses/summary", { address: addressRef(address), text: "讨论发布安排", version: view.summaryVersion });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).summaryText, "讨论发布安排");
  const staleMute = await post("/addresses/muted", { address: addressRef(address), muted: false, expected: true });
  assert.equal(staleMute.status, 409); assert.match((await staleMute.json()).error, /重新加载/);
  const staleSummary = await post("/addresses/summary", { address: addressRef(address), text: "过期修改", version: view.summaryVersion });
  assert.equal(staleSummary.status, 409); assert.match((await staleSummary.json()).error, /合并修改/);
  assert.equal(aide.addresses.view(addressRef(address)).summaryText, "讨论发布安排");
  for (let i = 0; i < 21; i++) aide.addresses.observe(webAddress(`page-${i}`));
  const first = await (await fetch(base + "/addresses/list?pageSize=10")).json();
  const second = await (await fetch(base + "/addresses/list?pageSize=10&page=2")).json();
  assert.equal(first.items.length, 10); assert.equal(first.total, 22); assert.equal(first.pages, 3);
  assert.equal(second.page, 2); assert.equal(second.items.length, 10);
  assert.deepEqual(first.pinned.map((item: { ref: { uid: string } }) => item.ref.uid), [aide.defaultAddress().uid]);
  assert.deepEqual(second.pinned, first.pinned);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.ref.uid)).size, 20);
  for (const query of ["page=0", "pageSize=101", "selectedUid=", "continue=invalid"])
    assert.equal((await fetch(base + "/addresses/list?" + query)).status, 400);
  const cursorPage = aide.addresses.page(); assert.ok(cursorPage.continue);
  aide.addresses.observe(webAddress("page-new"));
  assert.throws(() => aide.addresses.page(cursorPage.continue), /expir|chang/i);
  const query = new URLSearchParams({ name: address.metadata.name, uid: address.metadata.uid });
  for (let i = 0; i < 21; i++) await aide.addresses.client.create(NOTE_TYPE, {
    name: `address-note-${i}`, spec: { subject: addressRef(address), text: `事项 ${i}`, addresses: addressRefs([addressRef(address)]), people: personRefs([]) },
    status: { updatedAt: new Date().toISOString() },
  });
  const notes = await (await fetch(base + "/addresses/notes?" + query)).json(); assert.ok(notes.continue);
  query.set("continue", notes.continue);
  const latest = aide.addresses.view(addressRef(address));
  await aide.addresses.summarize(addressRef(address), "最新认识", latest.summaryVersion);
  assert.equal((await fetch(base + "/addresses/notes?" + query)).status, 410);
  query.set("continue", "invalid");
  assert.equal((await fetch(base + "/addresses/notes?" + query)).status, 400);
  const html = await (await fetch(base + "/addresses")).text(); assert.match(html, /参与者/); assert.match(html, /aria-label="刷新地址"/);
  assert.match(html, /aria-label="地址分页"/); assert.match(html, /上一页/); assert.match(html, /下一页/);
  assert.equal((await fetch(base + "/addresses.js")).status, 200);
});

/** @case Permission checks are queries; missing places cannot be discovered or granted authority by a send attempt. */
test("Address permission reads preserve resource versions and never discover missing places", async t => {
  const f = await setup(t), endpoint = larkAddress("app", "missing");
  const before = f.addresses.resources.list(ADDRESS_TYPE);
  assert.equal(f.addresses.canSpeak(endpoint), false);
  assert.equal(f.addresses.find(endpoint), undefined);
  assert.deepEqual(f.addresses.resources.list(ADDRESS_TYPE), before);
  const ref = addressRef(f.addresses.observe(group, [personRef(f.a)]));
  const original = f.addresses.read(ref);
  f.addresses.audience(ref); f.addresses.ref(ref); f.addresses.endpoint(ref); f.addresses.canSpeak(group);
  assert.deepEqual(f.addresses.read(ref), original);
  assert.throws(() => f.addresses.read({ ...ref, uid: "replaced" }), /no longer exists/);
});

test("Denied Output indexes the waiting and actual Me Address until delivery completes", async t => {
  const f = await setup(t);
  const fallback = addressRef(f.addresses.observe(webAddress("test"), [personRef(f.me)]));
  f.addresses.setMuted(fallback, true, false);
  const origin = f.addresses.ref(group);
  composeMail(f.store, "test", "blocked", mailDraft(f.topic, { topicId: "test", text: "private", target: origin }));
  await assert.rejects(f.checker.reconcile("blocked"), /not a verified private/);
  assert.deepEqual(f.store.get("blocked")!.status.waitingAddress, fallback);
  const { OUTPUT_TYPE } = await import("../plugins/personal/output/model.ts");
  const pending = () => f.store.resources.page(OUTPUT_TYPE, { limit: 10, matchIndex: { name: "pendingAddress", value: fallback.uid } }).items;
  assert.equal(pending().length, 1);
  f.addresses.setMuted(fallback, false, true);
  await f.checker.reconcile("blocked");
  assert.equal(f.store.get("blocked")!.status.waitingAddress, undefined);
  assert.deepEqual(f.store.get("blocked")!.status.delivery!.address, fallback);
  assert.equal(pending().length, 1);
  f.store.delivered("blocked"); assert.equal(pending().length, 0);
});

test("Topic replies retain message coordinates separately from the selected Address", async t => {
  const f = await setup(t);
  await seedInput(f.topics, "thread", { topicId: "test", origin: "channel", originId: "lark", source: group, replyToMessageId: "om_original", text: "question" });
  const ref = f.topics.inputStore.get("thread")!.spec.source!;
  const implicit = await f.topics.say("test", undefined, "implicit", undefined, { inputIds: ["thread"] });
  const explicit = await f.topics.say("test", undefined, "explicit", undefined, { respondToInputId: "thread", target: ref });
  for (const receipt of [implicit, explicit]) {
    const output = f.store.get(receipt.outputId)!;
    assert.deepEqual(output.spec.target, ref);
    assert.equal(output.spec.replyToMessageId, "om_original");
    assert.equal(larkEndpoint(f.store.destination(output))!.replyToMessageId, "om_original");
  }
});
