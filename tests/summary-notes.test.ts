import { personRefs } from "../plugins/personal/person/model.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { personRef, type PersonRef } from "../plugins/personal/person/model.ts";
import { upsertNote, readNote } from "../plugins/personal/note/service.ts";
import { summarizeTopic } from "../plugins/personal/topic/state.ts";
import { summaryVersion } from "../plugins/personal/topic/tree.ts";
import { ResourceStorageConfigSchema } from "../src/host/resource/storage.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { contentVersion } from "../plugins/personal/context-write.ts";
import { writeSummary, readSummary, summaryText } from "../plugins/personal/note/summary.ts";
import { NOTE_TYPE, NoteSpecSchema, noteVersion, type NoteSpec, type NoteStatus } from "../plugins/personal/note/model.ts";
import { readNotes } from "../plugins/personal/note/query.ts";
import { reconcileNote } from "../plugins/personal/note/reconcile.ts";
import { TOPIC_TYPE } from "../plugins/personal/topic/model.ts";
import type { ResourceClient } from "@compforge/aide-plugin";

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = mkdtempSync(join(tmpdir(), "aide-summary-notes-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No inference"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const client = aide.runtime.plugins.resourceClient("personal");
  const topic = await aide.topics.ensure("summary");
  return { aide, client, topic };
}
test("summaryOf associates one Note, edits the same Note and does not enter recent or review queues", async t => {
  const f = await fixture(t);
  const first = await writeSummary(f.client, f.topic, { text: "Stable understanding" });
  assert.equal("summary" in first.status, false);
  const note = (await readSummary(f.client, first))!;
  assert.equal(note.spec.summaryOf!.uid, first.metadata.uid);
  assert.equal(summaryText(f.aide.topics.resources, first), "Stable understanding");
  assert.deepEqual(await readNotes(f.client, first.metadata.uid, "subject"), []);
  const second = await writeSummary(f.client, first, { text: "Revised understanding" });
  assert.equal(first.summaryNote!.uid, second.summaryNote!.uid);
  assert.notEqual(contentVersion(first), contentVersion(second));
  assert.equal((await f.client.list(NOTE_TYPE)).length, 1);
  await assert.rejects(f.client.delete(NOTE_TYPE, note.metadata.name), /Summary subject still exists/);
  await assert.rejects(f.client.patchStatus(second, { summary: "raw text" } as never), /Unrecognized key/);
});
test("summary commit preserves scheduling changes and rejects concurrent content without partial Note writes", async t => {
  const f = await fixture(t), first = await writeSummary(f.client, f.topic, { text: "First" });
  await f.client.patchStatus(first, { idleReviewCount: 3 });
  const next = await writeSummary(f.client, first, { text: "Second" });
  assert.equal(next.status.idleReviewCount, 3);
  const race: ResourceClient = { ...f.client, async commit(writes) {
    await writeSummary(f.client, next, { text: "Concurrent correction" });
    return f.client.commit(writes);
  } };
  await assert.rejects(writeSummary(race, next, { text: "Stale replacement" }), /Test operation failed/);
  assert.equal((await readSummary(f.client, f.aide.topics.resource("summary")!))!.spec.text, "Concurrent correction");
});
test("Person summary is a Person subject and user edits share the Chief content store", async t => {
  const f = await fixture(t), p = await f.aide.persons.observe({ provider: "test", scope: "summary", id: "one" });
  const edited = await f.aide.persons.edit(p.metadata.name, p.metadata.uid, p.metadata.resourceVersion, p.spec, "User correction");
  const note = (await readSummary(f.client, edited))!;
  assert.equal(note.spec.subject.kind, "Person");
  assert.equal(note.spec.subject.uid, p.metadata.uid);
  assert.equal(edited.summaryText, "User correction");
  assert.deepEqual(edited.recent, []);
  const updated = await f.aide.persons.summarize(p.metadata.name, p.metadata.uid, edited.summaryVersion, "User correction retained");
  assert.equal(updated.summaryNote!.uid, edited.summaryNote!.uid);
  await assert.rejects(f.aide.persons.summarize(p.metadata.name, p.metadata.uid, edited.summaryVersion, "Stale"), /version conflict/);
});
test("retiring a summary owner preserves the independent Note", async t => {
  const f = await fixture(t), current = await writeSummary(f.client, f.topic, { text: "Understanding" });
  const note = (await readSummary(f.client, current))!;
  await f.client.delete(TOPIC_TYPE, current.metadata.name);
  await reconcileNote({ resources: f.client, logger: { info() {} } } as never, note);
  const deleted = await f.client.get({ ...NOTE_TYPE, namespace: "v1", name: note.metadata.name });
  assert.ok(deleted && !deleted.metadata.deletionTimestamp);
});

// @case Clearing knowledge retains the Note identity without blocking empty Topic capacity reclamation.
test("capacity evicts a Topic with cleared understanding, then its unreferenced Note becomes reclaimable", async t => {
  const f = await fixture(t);
  const first = await writeSummary(f.client, f.topic, { text: "Temporary understanding" });
  const cleared = await writeSummary(f.client, first, { text: "" });
  assert.equal(cleared.summaryNote!.uid, first.summaryNote!.uid);
  const note = (await readSummary(f.client, cleared))!;
  assert.equal(note.spec.text, "");
  await f.client.patchStatus(cleared, { lastInputAt: "2000-01-01T00:00:00.000Z" });
  f.aide.topics.resources.storage.configure(ResourceStorageConfigSchema.parse({ lowWatermark: 0.95,
    kinds: { "aide.dev/Topic": { maxCount: f.aide.topics.list().length } } }));
  const arrival = await f.aide.topics.ensure("new-arrival");
  assert.equal(f.aide.topics.resource("summary"), undefined);
  await reconcileNote({ resources: f.client, logger: { info() {} } } as never, note);
  assert.ok(await f.client.get({ ...NOTE_TYPE, namespace: "v1", name: note.metadata.name }));
  f.aide.topics.resources.storage.configure(ResourceStorageConfigSchema.parse({ lowWatermark: 0.95, kinds: { "aide.dev/Note": { maxCount: 1 } } }));
  await f.client.create(NOTE_TYPE, { name: "new-note", spec: { subject: resourceRef(arrival), people: [], text: "New evidence" }, status: { updatedAt: new Date().toISOString() } });
  assert.equal(await f.client.get({ ...NOTE_TYPE, namespace: "v1", name: note.metadata.name }), undefined);
});

// @case Summary ownership uses summaryOf rather than the Note name or an owner status field.
test("an existing Note can be selected as summary and edited through the shared Note API", async t => {
  const f = await fixture(t);
  const actor = await f.client.patchStatus(f.topic, { execution: { id: "chief", startedAt: new Date().toISOString() } });
  const a = await f.aide.persons.observe({ provider: "test", scope: "summary", id: "a" });
  const b = await f.aide.persons.observe({ provider: "test", scope: "summary", id: "b" });
  const people = personRefs([personRef(a), personRef(b)]).toJSON();
  const entry = await upsertNote(f.client, actor, { text: "Stable verified understanding", people: [people[0]] }, "existing");
  const note = await readNote(f.client, entry.noteId);
  const existing = (await f.client.get<NoteSpec, NoteStatus>({ ...NOTE_TYPE, namespace: "v1", name: note.id }))!;
  const spec = NoteSpecSchema.parse({ ...existing.spec, summaryOf: resourceRef(actor) });
  await f.client.commit([
    { operation: "replace", resource: existing, spec, status: existing.status },
    { operation: "patchStatus", resource: actor, patch: { summaryRevision: noteVersion({ ...existing, spec }) } },
  ]);
  const selected = f.aide.topics.resource("summary")!;
  assert.equal((await readSummary(f.client, selected))!.metadata.name, entry.noteId);
  await summarizeTopic(f.client, selected, "chief", { version: contentVersion(selected), summary: note.text, people }, 16000);
  const linked = f.aide.topics.resource("summary")!;
  assert.notEqual(summaryVersion(linked), summaryVersion(selected), "people changes invalidate dependent understanding");
  const read = await readNote(f.client, (await readSummary(f.client, linked))!.metadata.uid);
  assert.deepEqual(read.people, people);
  const result = await upsertNote(f.client, linked, { noteId: read.id, version: read.version, text: "Revised understanding" }, "edit");
  const latest = f.aide.topics.resource("summary")!;
  assert.equal((await readSummary(f.client, latest))!.metadata.uid, note.uid);
  assert.equal(latest.status.summaryRevision, result.version);
  assert.deepEqual((await readSummary(f.client, latest))!.spec.people.toJSON(), people, "omitting people preserves associations");
  await writeSummary(f.client, latest, { text: "Revised understanding", people: [] });
  assert.deepEqual((await readNote(f.client, note.uid)).people, []);
});

test("Person summary metadata survives user corrections and merges without copying historical identities", async t => {
  const f = await fixture(t);
  const a = await f.aide.persons.observe({ provider: "test", scope: "summary", id: "a" });
  const b = await f.aide.persons.observe({ provider: "test", scope: "summary", id: "b" });
  const people = personRefs([personRef(a), personRef(b)]).toJSON();
  const first = await f.aide.persons.summarize(a.metadata.name, a.metadata.uid, contentVersion(a), "A understanding", undefined, [people[0]!]);
  const second = await f.aide.persons.summarize(b.metadata.name, b.metadata.uid, contentVersion(b), "B understanding", undefined, [people[1]!]);
  const corrected = await f.aide.persons.edit(first.metadata.name, first.metadata.uid, first.metadata.resourceVersion, first.spec, "User corrected understanding");
  assert.deepEqual(corrected.summaryNote!.people, [people[0]]);
  assert.equal(corrected.summaryNote!.uid, first.summaryNote!.uid);
  const ref = (p: typeof corrected) => ({ id: p.metadata.name, uid: p.metadata.uid, version: p.metadata.resourceVersion });
  const merged = await f.aide.persons.merge(ref(second), ref(corrected));
  assert.deepEqual(merged.summaryNote!.people, [...people].sort((a, b) => a.uid < b.uid ? -1 : 1));
  assert.deepEqual((await f.aide.persons.read(merged.metadata.name)).summaryNote, merged.summaryNote);
  assert.ok((await readNote(f.client, second.summaryNote!.uid)).text, "source knowledge remains an independent Note");
});

// @case A live summaryOf subject protects its Note from capacity reclamation.
test("Note capacity preserves every referenced summary and evicts an older ordinary Note", async t => {
  const f = await fixture(t);
  const summary = await writeSummary(f.client, f.topic, { text: "Long-lived knowledge" });
  const subject = resourceRef(summary);
  await f.client.create(NOTE_TYPE, { name: "ordinary", spec: { subject, people: [], text: "Temporary detail" },
    status: { updatedAt: "2000-01-01T00:00:00.000Z" } });
  f.aide.topics.resources.storage.configure(ResourceStorageConfigSchema.parse({ lowWatermark: 0.95,
    kinds: { "aide.dev/Note": { maxCount: 2 } } }));
  await f.client.create(NOTE_TYPE, { name: "arrival", spec: { subject, people: [], text: "New detail" },
    status: { updatedAt: new Date().toISOString() } });
  assert.equal(await f.client.get({ ...NOTE_TYPE, namespace: "v1", name: "ordinary" }), undefined);
  assert.equal((await readSummary(f.client, summary))!.spec.text, "Long-lived knowledge");
});

// @case Protection follows the exact subject UID through deletion, never its reusable name.
test("terminating subjects protect summaries but a same-name replacement does not", async t => {
  const f = await fixture(t);
  const owner = await writeSummary(f.client, f.topic, { text: "Historical knowledge" });
  const note = (await readSummary(f.client, owner))!;
  await f.client.delete(TOPIC_TYPE, owner.metadata.name);
  await assert.rejects(f.client.delete(NOTE_TYPE, note.metadata.name), /Summary subject still exists/);
  f.aide.topics.resources.storage.configure(ResourceStorageConfigSchema.parse({ lowWatermark: 0.95,
    kinds: { "aide.dev/Note": { maxCount: 1 } } }));
  const other = await f.aide.topics.ensure("other");
  const create = () => f.client.create(NOTE_TYPE, { name: "arrival", spec: { subject: resourceRef(other), people: [], text: "Fresh evidence" },
    status: { updatedAt: new Date().toISOString() } });
  await assert.rejects(create());
  assert.ok(await f.client.get({ ...NOTE_TYPE, namespace: "v1", name: note.metadata.name }));
  f.aide.topics.resources.finalizeDeletion(TOPIC_TYPE, owner.metadata.name);
  const replacement = await f.aide.topics.ensure("summary");
  assert.notEqual(replacement.metadata.uid, owner.metadata.uid);
  await create();
  assert.equal(await f.client.get({ ...NOTE_TYPE, namespace: "v1", name: note.metadata.name }), undefined);
});

test("summaryOf uniqueness is transactional and cannot be cleared or redirected", async t => {
  const f = await fixture(t);
  const subject = resourceRef(f.topic);
  const results = await Promise.allSettled(["a", "b"].map(name => f.client.create(NOTE_TYPE, { name,
    spec: { subject, summaryOf: subject, people: [], text: "Summary" }, status: { updatedAt: new Date().toISOString() } })));
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const rejected = results.find(r => r.status === "rejected") as PromiseRejectedResult;
  assert.match(String(rejected.reason), /already has a summary/);
  const note = (await f.client.page<NoteSpec, NoteStatus>(NOTE_TYPE, { limit: 2, matchIndex: { name: "summaryOf", value: subject.uid } })).items[0]!;
  await assert.rejects(f.client.patch(note, { type: "json", value: [{ op: "remove", path: "/spec/summaryOf" }] }), /target is immutable/);
});

test("Note reconciliation repairs a cleared summary after the historical writer has finished", async t => {
  const f = await fixture(t);
  const actor = await f.client.patchStatus(f.topic, { execution: { id: "chief", startedAt: new Date().toISOString() } });
  const writer = { resource: resourceRef(actor), executionId: "chief" } as NonNullable<NoteStatus["writer"]>;
  const owner = await writeSummary(f.client, actor, { text: "Original knowledge" }, writer);
  const note = (await readSummary(f.client, owner))!;
  await f.client.patchStatus(owner, { execution: null });
  const { writer: _writer, ...status } = note.status;
  const changed = await f.client.replace(note, { ...note.spec, text: "" }, { ...status, updatedAt: new Date().toISOString() });
  await reconcileNote({ resources: f.client, logger: { debug() {} } } as never, changed);
  const latest = f.aide.topics.resource("summary")!;
  assert.equal(latest.status.summaryRevision, noteVersion(changed));
  assert.equal((await readSummary(f.client, latest))!.spec.text, "");
});

/** @case Ordinary and summary Notes support independent classification updates without erasing content. */
test("Note classification-only writes preserve body, associations and the summary owner's fingerprint", async t => {
  const f = await fixture(t);
  const actor = await f.client.patchStatus(f.topic, { execution: { id: "classify", startedAt: new Date().toISOString() } });
  const person = await f.aide.persons.observe({ provider: "test", scope: "classification", id: "a" });
  const people = [personRef(person) as PersonRef];
  const ordinary = await upsertNote(f.client, actor, { text: "Recent finding", people, sensitivity: "L1" }, "recent");
  const classified = await upsertNote(f.client, actor, { ...ordinary, sensitivity: "L2", visibility: "topic" }, "classification");
  const recent = await readNote(f.client, ordinary.noteId);
  assert.equal(recent.text, "Recent finding"); assert.deepEqual(recent.people, people);
  assert.equal(recent.sensitivity, "L2"); assert.equal(recent.visibility, "topic");
  await assert.rejects(upsertNote(f.client, actor, { ...ordinary, visibility: "any" }, "stale"), /version conflict/);
  const rewritten = await upsertNote(f.client, actor, { ...classified, text: "Revised finding" }, "rewrite");
  assert.equal((await readNote(f.client, rewritten.noteId)).sensitivity, "L2");
  const owner = await writeSummary(f.client, actor, { text: "Long-term understanding", people, sensitivity: "L1" });
  const summary = owner.summaryNote!;
  await upsertNote(f.client, actor, { noteId: summary.id, version: summary.version, sensitivity: "L2", visibility: "root" }, "summary-classification");
  const current = f.aide.topics.resource("summary")!;
  const note = (await readSummary(f.client, current))!;
  assert.equal(note.spec.text, "Long-term understanding"); assert.deepEqual(note.spec.people.toJSON(), people);
  assert.equal(note.spec.visibility, "root"); assert.equal(note.spec.sensitivity, "L2");
  assert.equal(current.status.summaryRevision, noteVersion(note));
});

/** @case Person has no Topic scope; storing internal knowledge must not depend on resolving a sending audience. */
test("Person summaries accept topic and root classifications", async t => {
  const f = await fixture(t), p = await f.aide.persons.observe({ provider: "test", scope: "classification", id: "person" });
  for (const visibility of ["topic", "root"] as const) {
    const current = (await f.aide.persons.read(p.metadata.name, p.metadata.uid))!;
    const updated = await f.aide.persons.summarize(p.metadata.name, p.metadata.uid, current.summaryVersion, "Stable understanding", undefined, undefined, { visibility });
    assert.equal((await readSummary(f.client, updated))!.spec.visibility, visibility);
  }
});

/** @case Supplying absorbed receipts must never swallow a simultaneous classification-only edit. */
test("Topic review receipts and summary classification commit together", async t => {
  const f = await fixture(t);
  const actor = await f.client.patchStatus(f.topic, { execution: { id: "review", startedAt: new Date().toISOString() } });
  const owner = await writeSummary(f.client, actor, { text: "Durable finding", sensitivity: "L1" });
  const child = await f.client.create(TOPIC_TYPE, { name: "child", spec: { id: "child", parentRef: resourceRef(owner) }, status: {} });
  const { understandingVersion } = await import("../plugins/personal/topic/tree.ts");
  const version = understandingVersion(child as import("../plugins/personal/topic/model.ts").TopicResource, []);
  await summarizeTopic(f.client, owner, "review", { version: contentVersion(owner), sensitivity: "L2", visibility: "root", absorbed: [{ uid: child.metadata.uid, version }] }, 4000);
  const current = f.aide.topics.resource("summary")!, note = (await readSummary(f.client, current))!;
  assert.equal(current.status.absorbed![child.metadata.uid], version);
  assert.equal(note.spec.text, "Durable finding"); assert.equal(note.spec.sensitivity, "L2"); assert.equal(note.spec.visibility, "root");
});


test("summary and Topic people are sets; a permutation does not change summary understanding", async t => {
  const f = await fixture(t);
  const a = personRef(await f.aide.persons.observe({ provider: "test", scope: "summary", id: "a" })) as PersonRef;
  const b = personRef(await f.aide.persons.observe({ provider: "test", scope: "summary", id: "b" })) as PersonRef;
  const topic = await f.client.replace(f.topic, { ...f.topic.spec, people: personRefs([b, a, b]) }, f.topic.status);
  assert.deepEqual(topic.spec.people?.toJSON().map(p => p.uid), [a.uid, b.uid].sort());
  const first = await writeSummary(f.client, topic, { text: "Stable", people: [b, a, b] });
  const before = (await readSummary(f.client, first))!;
  const next = await writeSummary(f.client, first, { people: [b, a, a] });
  const after = (await readSummary(f.client, next))!;
  assert.equal(next.status.summaryRevision, first.status.summaryRevision);
  assert.equal(after.status.updatedAt, before.status.updatedAt);
  assert.deepEqual(after.spec.people.toJSON().map(p => p.uid), [a.uid, b.uid].sort());
});
