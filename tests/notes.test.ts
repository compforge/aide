import { groupTopics } from "../plugins/personal/weave/service.ts";
import { WEAVE_TYPE } from "../plugins/personal/weave/model.ts";
import { readNote } from "../plugins/personal/note/service.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { ResourceClient } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "../plugins/personal/topic/model.ts";
import { summarizeTopic, upsertTopicNote } from "../plugins/personal/topic/state.ts";
import { understandingVersion } from "../plugins/personal/topic/tree.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { contentVersion } from "../plugins/personal/context-write.ts";
import { notes, readNotes } from "../plugins/personal/note/query.ts";
import { NOTE_TYPE } from "../plugins/personal/note/model.ts";
import { PERSON_TYPE, type PersonRef } from "../plugins/personal/person/model.ts";
import { ResourceStorageConfigSchema } from "../src/host/resource/storage.ts";
import { chiefNoteTools } from "../agents/chief/note-tools.ts";
import { workContextTools } from "../plugins/personal/work-context.ts";
import { ROUTINE_TYPE } from "../plugins/personal/routine/model.ts";
import type { WorkResource } from "../plugins/personal/resources.ts";
const log = pino({ level: "silent" });
async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-notes-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected inference"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const original = await aide.topics.ensure("notes");
  const root = await resources.patchStatus(original, { execution: { id: "live", startedAt: new Date().toISOString() }, summary: "Distinguish reported and verified completion." });
  const read = () => aide.topics.resource("notes")!;
  const recent = () => notes(aide.topics.resources, root.metadata.uid);
  const upsert = (raw: unknown, callId: string, client = resources) => upsertTopicNote(client, root, "live", raw, callId);
  return { aide, resources, root, read, recent, upsert };
}
test("one independent Note follows progress; tool retries preserve newer content and concurrent notes do not conflict", async t => {
  const f = await setup(t), initial = f.read();
  const first = await f.upsert({ text: "Started X" }, "start");
  const at = f.recent()[0]!.createdAt;
  await f.resources.patchStatus(initial, { reviewCheckedAt: new Date().toISOString(), idleReviewCount: 5 });
  const other = await f.upsert({ text: "Separate matter" }, "other");
  const done = await f.upsert({ ...first, text: "X reported complete; verification pending" }, "done");
  assert.notEqual(other.noteId, done.noteId);
  const replay = await f.upsert({ text: "Started X" }, "start");
  assert.equal(replay.version, done.version);
  assert.equal((await f.upsert({ ...done, text: "X reported complete; verification pending" }, "same")).version, done.version);
  assert.equal(f.recent().find(n => n.id === first.noteId)!.createdAt, at);
  assert.equal(f.read().status.summary, initial.status.summary);
  assert.equal("recent" in f.read().status, false);
  await assert.rejects(f.upsert({ ...first, text: "stale edit" }, "stale"), /version conflict/);
  await assert.rejects(f.upsert({ noteId: "missing", version: done.version, text: "resurrection" }, "missing"), /no longer exists/);
});
test("summary edits survive scheduling and Note changes, but reject concurrent content changes", async t => {
  const f = await setup(t), original = f.read(), version = contentVersion(original);
  await f.resources.patchStatus(original, { reviewCheckedAt: new Date().toISOString(), idleReviewCount: 2 });
  await f.upsert({ text: "Recent evidence" }, "evidence");
  const result = await summarizeTopic(f.resources, original, "live", { version, summary: "Durable correction" }, 4000);
  assert.equal(result.version, contentVersion(f.read())); assert.equal(f.read().status.idleReviewCount, 2);
  assert.equal(f.recent().length, 1);
  await assert.rejects(summarizeTopic(f.resources, original, "live", { version, summary: "old interpretation" }, 4000), /context changed/);
  const current = f.read();
  const race: ResourceClient = { ...f.resources, async patch(resource, patch, options) {
    await f.resources.patchStatus(current, { summary: "Concurrent user correction" });
    return f.resources.patch(resource, patch, options);
  } };
  await assert.rejects(summarizeTopic(race, current, "live", { version: contentVersion(current), summary: "overwrite" }, 4000), /Test operation failed/);
  assert.equal(f.read().status.summary, "Concurrent user correction");
});
test("content writes validate execution and intermediate Topic ownership inside the transaction", async t => {
  const f = await setup(t);
  const other = await f.aide.topics.ensure("other");
  const middle = await f.resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, { name: "middle", spec: { id: "middle", parentRef: resourceRef(f.root) }, status: { summary: "", receipts: [] } });
  const leaf = await f.resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, { name: "leaf", spec: { id: "leaf", parentRef: resourceRef(middle) }, status: { summary: "", receipts: [] } });
  const race: ResourceClient = { ...f.resources, async patch(resource, patch, options) {
    await f.resources.replace(middle, { ...middle.spec, parentRef: resourceRef(other) }, middle.status);
    return f.resources.patch(resource, patch, options);
  } };
  await assert.rejects(summarizeTopic(race, f.root, "live", { topicUid: leaf.metadata.uid, version: contentVersion(leaf), summary: "outside" }, 4000), /outside/);
  const switchExecution: ResourceClient = { ...f.resources, async create(type, init) {
    await f.resources.patchStatus(f.root, { execution: { id: "new", startedAt: new Date().toISOString() } });
    return f.resources.create(type, init);
  } };
  await assert.rejects(f.upsert({ text: "old execution" }, "late", switchExecution), /no longer active/);
  assert.equal(f.recent().length, 0);
});
test("one Chief tool writes subject and people; Person and Topic queries find the same Note", async t => {
  const f = await setup(t), person = await f.aide.persons.observe({ provider: "test", scope: "team", id: "one" }, "Alice");
  const ref = resourceRef(person) as PersonRef;
  const tool = chiefNoteTools((input, id) => f.upsert(input, id))[0]!;
  await tool.execute("one", { text: "Alice is investigating X", people: [ref, ref] }, undefined, undefined, {} as never);
  const a = f.recent()[0]!, b = (await f.aide.persons.read(person.metadata.name)).recent[0]!;
  assert.equal(a.id, b.id); assert.deepEqual(a.people, [ref]); assert.equal(a.subject.uid, f.root.metadata.uid);
  await f.upsert({ noteId: a.id, version: a.version, text: "Alice has new evidence" }, "progress");
  assert.deepEqual(f.recent()[0]!.people, [ref]);
  await f.resources.delete(PERSON_TYPE, person.metadata.name); f.aide.topics.resources.finalizeDeletion(PERSON_TYPE, person.metadata.name);
  assert.equal(f.recent()[0]!.people[0]!.uid, person.metadata.uid, "Deleting a Person preserves historical attribution");
  const latest = f.recent()[0]!;
  await f.upsert({ noteId: latest.id, version: latest.version, text: latest.text, people: [] }, "clear");
  assert.deepEqual(await readNotes(f.resources, person.metadata.uid, "people"), []);
});
test("Notes outlive subjects and capacity evicts old Notes without recreating evicted updates", async t => {
  const f = await setup(t);
  f.aide.topics.resources.storage.configure(ResourceStorageConfigSchema.parse({ kinds: { "aide.dev/Note": { maxCount: 2 } }, lowWatermark: 0.95 }));
  const first = await f.upsert({ text: "Old" }, "first");
  const old = (await f.resources.get({ ...NOTE_TYPE, namespace: "v1", name: first.noteId }))!;
  await f.resources.patchStatus(old, { updatedAt: "2000-01-01T00:00:00.000Z" });
  await f.upsert({ text: "Second" }, "second");
  await f.upsert({ text: "Third" }, "third");
  assert.ok((await f.resources.list(NOTE_TYPE)).length <= 2);
  await assert.rejects(f.upsert({ ...first, text: "revive" }, "revive"), /no longer exists/);
  const retained = await f.resources.list(NOTE_TYPE);
  assert.ok(retained.length > 0);
  const live = f.read();
  await f.resources.patch(live, { type: "json", value: [{ op: "remove", path: "/status/execution" }] });
  await f.resources.delete(TOPIC_TYPE, live.metadata.name); f.aide.topics.resources.finalizeDeletion(TOPIC_TYPE, live.metadata.name);
  assert.deepEqual(await f.resources.list(NOTE_TYPE), retained);
});
test("child understanding includes independent Note revisions and detects concurrent Note creation", async t => {
  const f = await setup(t);
  const child = await f.resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, { name: "child", spec: { id: "child", parentRef: resourceRef(f.root) }, status: { summary: "Child", receipts: [] } });
  await f.upsert({ subject: resourceRef(child), text: "Child evidence" }, "child-note");
  const version = understandingVersion(child, await readNotes(f.resources, child.metadata.uid));
  const race: ResourceClient = { ...f.resources, async patch(resource, patch, options) {
    await f.upsert({ subject: resourceRef(child), text: "Late evidence" }, "late-note");
    return f.resources.patch(resource, patch, options);
  } };
  await assert.rejects(summarizeTopic(race, f.root, "live", { version: contentVersion(f.read()), absorbed: [{ uid: child.metadata.uid, version }] }, 4000), /Child understanding changed/);
  assert.equal(f.read().status.absorbed?.[child.metadata.uid], undefined);
  const latest = understandingVersion(child, await readNotes(f.resources, child.metadata.uid));
  await summarizeTopic(f.resources, f.root, "live", { version: contentVersion(f.read()), absorbed: [{ uid: child.metadata.uid, version: latest }] }, 4000);
  assert.equal(f.read().status.absorbed?.[child.metadata.uid], latest);
});
test("Work summary and Notes use content versions and enforce the bound subject", async t => {
  const f = await setup(t);
  const original = await f.resources.create(ROUTINE_TYPE, { name: "work", spec: { title: "Monitor", instruction: "Check", paused: false, trigger: { cron: null, event: "tick", timezone: "UTC" } },
    status: { topic: resourceRef(f.root), summary: "", execution: { id: "work-live", startedAt: new Date().toISOString() } } }) as WorkResource;
  const tools = workContextTools("routine", f.resources, () => original, log);
  await f.resources.patchStatus(original, { nextTriggerAt: new Date().toISOString() });
  await tools.find(t => t.name === "summarize_routine")!.execute("summary", { version: contentVersion(original), summary: "Stable" }, undefined, undefined, {} as never);
  const tool = tools.find(t => t.name === "upsert_note")!;
  await tool.execute("note", { text: "Current check" }, undefined, undefined, {} as never);
  assert.equal((await readNotes(f.resources, original.metadata.uid)).length, 1);
  const current = (await f.resources.get<WorkResource["spec"], WorkResource["status"]>(resourceRef(original)))!;
  const race: ResourceClient = { ...f.resources, async patch(resource, patch, options) {
    await f.resources.patchStatus(current, { summary: "Concurrent correction" });
    return f.resources.patch(resource, patch, options);
  } };
  const summarize = workContextTools("routine", race, () => current, log).find(t => t.name === "summarize_routine")!;
  await assert.rejects(summarize.execute("race", { version: contentVersion(current), summary: "Unseen overwrite" }, undefined, undefined, {} as never),
    (error: Error) => /summary version conflict; read_routine and merge again/.test(error.message) && (error.cause as Error).name === "TEST_OPERATION_FAILED");
  assert.equal((await f.resources.get<WorkResource["spec"], WorkResource["status"]>(resourceRef(original)))!.status.summary, "Concurrent correction");
  await assert.rejects(tool.execute("outside", { subject: resourceRef(f.root), text: "Wrong subject" }, undefined, undefined, {} as never), /own content/);
});

test("read_note returns complete content after recent projection truncates it", async t => {
  const f = await setup(t);
  const text = "Evidence ".repeat(1700);
  const first = await f.upsert({ text }, "long-first");
  const second = await f.upsert({ text }, "long-second");
  const window = f.recent();
  assert.ok(window.some(n => n.text.length < text.trim().length));
  for (const id of [first.noteId, second.noteId]) assert.equal((await readNote(f.resources, id)).text, text.trim());
});

test("Weave grouping rejects Note-only changes between review and commit", async t => {
  const f = await setup(t), parent = await f.aide.topics.ensure("parent");
  const weave = await f.resources.create(WEAVE_TYPE, { name: "global", spec: {}, status: {} });
  const root = f.read();
  const race: ResourceClient = { ...f.resources, async commit(writes) {
    await f.upsert({ text: "Evidence arrived after review" }, "weave-race");
    return f.resources.commit(writes);
  } };
  await assert.rejects(groupTopics(race, weave, {
    topics: [{ uid: root.metadata.uid, version: understandingVersion(root) }],
    parent: { uid: parent.metadata.uid, version: understandingVersion(parent) },
  }, 4000), /understanding changed/);
  assert.equal(f.read().metadata.resourceVersion, root.metadata.resourceVersion, "Only the independent Note changed");
  assert.equal(f.read().spec.parentRef, undefined);
  assert.deepEqual(f.aide.topics.resource("parent"), parent, "The grouping transaction rolled back");
});

test("summary response version identifies its committed content, not a later concurrent edit", async t => {
  const f = await setup(t), initial = f.read();
  const race: ResourceClient = { ...f.resources, async patch(resource, patch, options) {
    const written = await f.resources.patch(resource, patch, options);
    await f.resources.patchStatus(f.read(), { summary: "Later correction" });
    return written;
  } };
  const result = await summarizeTopic(race, initial, "live", { version: contentVersion(initial), summary: "My synthesis" }, 4000);
  assert.equal(result.version, contentVersion({ ...initial, status: { ...initial.status, summary: "My synthesis" } }));
  await assert.rejects(summarizeTopic(f.resources, initial, "live", { version: result.version, summary: "Would overwrite unseen correction" }, 4000), /context changed/);
});
