import { personRefs } from "../plugins/personal/person/model.ts";
import { createWithSummary, patchSummary } from "./summary-fixture.ts";
import { notes } from "../plugins/personal/note/query.ts";
import { seedNotes } from "./fixtures/notes.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { InputSpecSchema } from "../plugins/personal/input/definition.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../plugins/personal/input/model.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { inputPrinter } from "../plugins/personal/input/printer.ts";
import { personRef, PERSON_TYPE, type PersonRef } from "../plugins/personal/person/model.ts";
import { knownReceivers, messageReceivers } from "../plugins/personal/person/receivers.ts";
import { topicPersons } from "../plugins/personal/topic/persons.ts";
import { retainRecent } from "../plugins/personal/context.ts";
import { upsertTopicNote } from "../plugins/personal/topic/state.ts";
import { TOPIC_TYPE, type TopicResource } from "../plugins/personal/topic/model.ts";
import { SOURCES } from "../plugins/personal/source/definition.ts";
import { topicCandidatePage, topicParts, understanding } from "../plugins/personal/background.ts";
import { searchRootTopics } from "../plugins/personal/weave/candidates.ts";
import { topicTools } from "../plugins/personal/topic/tools.ts";
import type { ChatMessage } from "@compforge/aide-plugin";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-topic-persons-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No inference expected"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal"), store = aide.personal.store;
  const person = async (id: string, name = id) => personRef(await aide.persons.observe({ provider: "lark", scope: "cli_people", id: `ou_${id}` }, name)) as PersonRef;
  const input = async (id: string, topic: TopicResource, spec: Partial<InputSpec> = {}) => resources.create<InputSpec, InputStatus>(INPUT_TYPE, {
    name: id, spec: { origin: "source", originId: "test", text: id, ...spec },
    status: { topic: resourceRef(topic), route: { completedAt: new Date().toISOString(), result: { topics: [resourceRef(topic)], reason: "test" } },
      assess: { completedAt: new Date().toISOString(), result: { summary: "done" } } },
  });
  return { aide, resources, store, person, input };
}

test("receiver facts are optional, immutable Person references; empty does not encode all", async t => {
  const f = fixture(t), root = await f.aide.topics.ensure("receivers"), receiver = await f.person("receiver");
  const base = { origin: "source", originId: "test", text: "fact" };
  assert.equal(InputSpecSchema.parse(base).receivers, undefined);
  assert.deepEqual(InputSpecSchema.parse({ ...base, receivers: [] }).receivers?.toJSON(), []);
  for (const receivers of ["all", ["all"], [{ ...receiver, kind: "Audience" }], [{ ...receiver, uid: undefined }]])
    assert.equal(InputSpecSchema.safeParse({ ...base, receivers }).success, false);
  const fact = await f.input("addressed", root, { receivers: personRefs([receiver]) });
  assert.deepEqual(f.aide.topics.inputStore.get("addressed")!.spec.receivers?.toJSON(), [receiver]);
  assert.match(inputPrinter.describe(fact), /Explicit receiver Persons/);
  await assert.rejects(f.resources.replace(fact, { ...fact.spec, receivers: personRefs([]) }, fact.status), /immutable/);
});

test("receiver resolution uses scoped verified humans and actual direct/reply evidence without expanding an audience", async t => {
  const f = fixture(t), known = await f.person("known");
  await f.aide.persons.observe({ provider: "lark", scope: "cli_elsewhere", id: "ou_foreign" });
  const before = (await f.aide.persons.list()).length;
  assert.deepEqual(await knownReceivers(f.aide.persons, "cli_people", ["ou_known", "ou_known", "ou_unknown", "ou_foreign", "all"]), [known]);
  assert.equal((await f.aide.persons.list()).length, before, "untyped IDs never create people");
  const message: ChatMessage = { id: "child", chatId: "chat", sender: { id: "ou_sender", type: "user" },
    mentions: [], content: "reply", parentId: "parent", deleted: false, createdAt: new Date().toISOString() };
  const parent = { ...message, id: "parent", sender: { id: "ou_parent", type: "user" } };
  const refs = await messageReceivers(f.aide.persons, "cli_people", message, [parent], "ou_account");
  const ids = await Promise.all(refs.map(ref => f.aide.persons.read(ref.name, ref.uid).then(p => p.spec.identities[0]!.id)));
  assert.deepEqual(ids.sort(), ["ou_account", "ou_parent"]);
  assert.deepEqual(await messageReceivers(f.aide.persons, "cli_people", { ...message, sender: { id: "ou_account", type: "user" } }, [] , "ou_account"), []);
  assert.deepEqual(await messageReceivers(f.aide.persons, "cli_people", message, [{ ...parent, chatId: "different" }]), []);
});

test("Notes keep optional UID-pinned people through updates, clearing, retention and stale references", async t => {
  const f = fixture(t), initial = await f.aide.topics.ensure("notes");
  await f.resources.patchStatus(initial, { execution: { id: "chief", startedAt: new Date().toISOString() } });
  const read = () => f.aide.topics.resource("notes")!;
  const one = await f.person("one", "Same name"), two = await f.person("two", "Same name");
  const update = (args: Record<string, unknown>, call: string) => upsertTopicNote(f.resources, read(), "chief", {
    version: args.noteId ? notes(f.store.resources, read().metadata.uid, "subject").find(n => n.id === args.noteId)?.version : undefined, text: "Discuss release", ...args,
  } as never, call);
  const created = await update({}, "create");
  assert.deepEqual(notes(f.store.resources, read().metadata.uid, "subject")[0]!.people, []);
  await update({ noteId: created.noteId, people: [one, two, one] }, "people");
  assert.deepEqual(notes(f.store.resources, read().metadata.uid, "subject")[0]!.people, [one, two], "Same text can gain people; UID deduplicates, names do not");
  await update({ noteId: created.noteId, text: "Discuss release progress" }, "progress");
  assert.deepEqual(notes(f.store.resources, read().metadata.uid, "subject")[0]!.people, [one, two]);
  assert.deepEqual(retainRecent(notes(f.store.resources, read().metadata.uid, "subject"))[0]!.people, [one, two], "Synthesis/retention preserves associations");
  await assert.rejects(update({ noteId: created.noteId, people: [{ ...one, kind: "Topic" }] }, "invalid"), /Person/);
  await f.resources.delete(PERSON_TYPE, one.name);
  f.store.resources.finalizeDeletion(PERSON_TYPE, one.name);
  await createWithSummary(f.resources, PERSON_TYPE, { name: one.name, spec: { name: "Replacement", identities: [] },
    status: { summary: "private-profile-marker", updatedAt: new Date().toISOString(), updatedBy: "user" } });
  await update({ noteId: created.noteId, text: "Keep historical attribution" }, "historical");
  const view = topicPersons(f.store, read());
  assert.equal(view.items.length, 2);
  assert.ok("unavailable" in view.items[0]! && view.items[0].unavailable);
  assert.doesNotMatch(JSON.stringify(view), /Replacement|private-profile-marker/);
  const copied = await update({ people: [one] }, "copy-historical");
  assert.deepEqual(notes(f.store.resources, read().metadata.uid, "subject").find(n => n.id === copied.noteId)!.people, [one]);
  await update({ noteId: copied.noteId, people: [] }, "clear-copy");
  await update({ noteId: created.noteId, people: [] }, "clear");
  assert.deepEqual(notes(f.store.resources, read().metadata.uid, "subject")[0]!.people, []);
  assert.deepEqual(topicPersons(f.store, read()).items, []);
});

test("Topic people use only its own recent Notes and project names without Input scans or retention writes", async t => {
  const f = fixture(t), root = await f.aide.topics.ensure("root"), child = await f.aide.topics.ensure("child");
  const refs = await Promise.all(Array.from({ length: 10 }, (_, i) => f.person(`p${i}`)));
  await f.input("unnoted", root, { sender: refs[0], receivers: personRefs(refs) });
  const at = new Date().toISOString();
  await f.resources.replace(child, { ...child.spec, parentRef: resourceRef(root) }, child.status);
  await seedNotes(f.resources, child, [{ id: "child-note", text: "Child matter", people: refs }]);
  assert.deepEqual(topicPersons(f.store, root).items, [], "Neither Inputs nor child Notes implicitly populate the root");
  await seedNotes(f.resources, root, [{ id: "root-note", text: "Synthesized matter", people: refs }]);
  const noted = f.aide.topics.resource("root")!;
  const db = f.store.resources.storage.db, before = db.prepare("SELECT total_changes() AS n").get()!.n;
  const expected = topicPersons(f.store, noted);
  assert.equal(db.prepare("SELECT total_changes() AS n").get()!.n, before);
  assert.equal(expected.items.length, 8); assert.equal(expected.omittedPersons, 2);
  assert.equal(expected.source, "recentNotes"); assert.equal(expected.noteCount, 1);
  const preview = understanding({ ...noted.status, summary: "", recent: notes(f.store.resources, noted.metadata.uid, "subject") }).recent[0]!;
  assert.equal(preview.people!.length, 8); assert.equal(preview.peopleOmitted, 2);
  assert.equal(notes(f.store.resources, noted.metadata.uid, "subject")[0]!.people!.length, 10, "Only the preview is truncated");
  assert.deepEqual(topicCandidatePage(f.store).items.find(t => t.uid === root.metadata.uid)!.persons, expected);
  assert.match(topicParts(f.store, noted, root.spec.id).topic, /recentNotes/);
  const read = await topicTools(f.store, () => noted).find(t => t.name === "read_topic")!.execute("read", {}, undefined, undefined, {} as never);
  assert.match(JSON.stringify(read), /recentNotes/);
});

test("Weave enriches only page candidates, preserves offsets and separates directory and page fingerprints", async t => {
  const f = fixture(t), base = await f.aide.topics.ensure("base");
  const roots = Array.from({ length: 100 }, (_, i) => ({ ...base, metadata: { ...base.metadata, uid: String(i) }, spec: { id: String(i) } }));
  let calls = 0;
  const project = () => { calls++; return { items: [], source: "recentNotes" as const, noteCount: 0, omittedPersons: 0 }; };
  const first = searchRootTopics(roots, undefined, 0, 12, project);
  assert.equal(calls, 12); assert.equal(first.items.length, 12); assert.equal(first.matchingRootCount, 100);
  calls = 0;
  const next = searchRootTopics(roots, undefined, first.nextOffset!, 12, project);
  assert.equal(calls, 12); assert.equal(next.items[0]!.uid, "12");
  assert.equal(first.catalogFingerprint, next.catalogFingerprint); assert.notEqual(first.fingerprint, next.fingerprint);
  const changed = searchRootTopics(roots, undefined, 0, 12, () => ({ ...project(), omittedPersons: 1 }));
  assert.equal(first.catalogFingerprint, changed.catalogFingerprint); assert.notEqual(first.fingerprint, changed.fingerprint);
  calls = 0;
  assert.equal(searchRootTopics(roots, undefined, 100, 12, project).items.length, 0); assert.equal(calls, 0);
  const large = roots.map(r => ({ ...r, status: { ...r.status, summary: "s".repeat(1200) } }));
  calls = 0;
  const bounded = searchRootTopics(large, undefined, 0, 20, project, () => "s".repeat(1200));
  assert.ok(bounded.items.length < 20); assert.equal(calls, bounded.items.length + 1);
  assert.equal(bounded.nextOffset, bounded.items.length);
});

test("Route and Chief query people and recent activity only for the current page", async t => {
  const f = fixture(t), person = await f.person("participant"), at = new Date().toISOString();
  for (let i = 0; i < 25; i++) {
    const root = await f.aide.topics.ensure(`root-${i}`);
    await patchSummary(f.resources, root, { summary: "s".repeat(2000) });
    await seedNotes(f.resources, root, [{ id: "note", text: "Matter", people: [person] }]);
  }
  const db = f.store.resources.storage.db, prepare = db.prepare.bind(db);
  let people = 0, activities = 0;
  db.prepare = ((sql: string, ...args: unknown[]) => {
    if (sql.includes("kind='aide.dev/Person'")) people++;
    if (sql.includes("WITH RECURSIVE tree")) activities++;
    return prepare(sql, ...args as []);
  }) as typeof db.prepare;
  t.after(() => { db.prepare = prepare; });
  const page = topicCandidatePage(f.store);
  assert.ok(page.items.length < 20);
  assert.equal(people, page.items.length + 1); assert.equal(activities, page.items.length + 1);
  const root = await f.aide.topics.ensure("chief");
  for (const child of f.store.resources.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE).filter(t => t.metadata.uid !== root.metadata.uid))
    await f.resources.replace(child, { ...child.spec, parentRef: resourceRef(root) }, child.status);
  people = 0;
  const tools = topicTools(f.store, () => root);
  const result = await tools.find(t => t.name === "list_topics")!.execute("page", {}, undefined, undefined, {} as never);
  const content = result.content[0]!; assert.equal(content.type, "text");
  if (content.type !== "text") throw new Error("Expected text");
  const children = JSON.parse(content.text);
  assert.equal(people, children.items.length + (children.items.length < 20 ? 1 : 0));
  people = 0;
  topicParts(f.store, root, root.spec.id);
  assert.ok(people <= 21, "Automatic Chief background also bounds child projections");
});
