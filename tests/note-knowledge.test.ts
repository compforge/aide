import { collectResources } from "./fixtures/resource-gc.ts";
import { createWithSummary, patchSummary } from "./summary-fixture.ts";
import { createReviewInput } from "../plugins/personal/topic/review.ts";
import { maintenanceAgenda } from "../plugins/personal/topic/maintenance.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { ResourceClient, PluginContext } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "../plugins/personal/topic/model.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { upsertTopicNote } from "../plugins/personal/topic/state.ts";
import { readNote } from "../plugins/personal/note/service.ts";
import { moveNote } from "../plugins/personal/note/operations.ts";
import { listNotes, notes } from "../plugins/personal/note/query.ts";
import { NOTE_TYPE, noteVersion, type NoteSpec, type NoteStatus } from "../plugins/personal/note/model.ts";
import { reconcileNote } from "../plugins/personal/note/reconcile.ts";
import { collectTopic } from "../plugins/personal/topic/lifecycle.ts";
import { ResourceStorageConfigSchema } from "../src/host/resource/storage.ts";
import { topicTools } from "../plugins/personal/topic/tools.ts";
import { reclamationVersion } from "../plugins/personal/topic/retention.ts";
import { ROUTINE_TYPE } from "../plugins/personal/routine/model.ts";
import { INPUT_TYPE, InputAttention } from "../plugins/personal/input/model.ts";
import { reconcileChief } from "../plugins/personal/topic/reconcile.ts";
const log = pino({ level: "silent" });
async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-knowledge-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected inference"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const original = await aide.topics.ensure("knowledge");
  const root = await resources.patchStatus(original, { execution: { id: "live", startedAt: new Date().toISOString() } });
  const read = () => aide.topics.resource("knowledge")!;
  const note = async (raw: unknown, callId: string) => {
    const { noteId, version } = await upsertTopicNote(resources, read(), "live", raw, callId);
    return { noteId, version };
  };
  const get = async (id: string) => (await resources.get<NoteSpec, NoteStatus>({ ...NOTE_TYPE, namespace: "v1", name: id }))!;
  const context = { resources, logger: { info() {}, debug() {} }, instance: { config: { topic: { idleMs: 1000 } } } } as unknown as PluginContext;
  return { aide, resources, root, read, note, get, context };
}

test("Note discovery covers retained history beyond recent with bounded search pages", async t => {
  const f = await setup(t), ids = new Set<string>();
  for (let i = 0; i < 45; i++) ids.add((await f.note({ text: `matter-${i}: ${"x".repeat(1000)}` }, String(i))).noteId);
  let token = "", scanned = 0, found = 0;
  do {
    const page = await listNotes(f.resources, { subject: f.root.metadata.uid, q: "matter-44:", continue: token, limit: 7 });
    assert.ok(page.scanned <= 7);
    scanned += page.scanned; found += page.items.length;
    for (const n of page.items) { assert.ok(n.truncated); assert.equal(n.text.length, 500); assert.ok(ids.has(n.id)); }
    token = page.continue;
  } while (token);
  assert.equal(scanned, 45); assert.equal(found, 1);
});

test("move_note preserves matter identity and age, rejects stale versions and cross-root moves", async t => {
  const f = await setup(t);
  const child = await createWithSummary<TopicSpec, TopicStatus>(f.resources, TOPIC_TYPE, { name: "child", spec: { id: "child", parentRef: resourceRef(f.root) }, status: { summary: "", receipts: [] } });
  const outsider = await f.aide.topics.ensure("outside");
  const initial = await f.note({ text: "One continuing matter" }, "start"), before = await readNote(f.resources, initial.noteId);
  const moved = await moveNote(f.resources, f.read(), { ...initial, subject: resourceRef(child), reason: "Matter belongs to the child" });
  const after = await readNote(f.resources, initial.noteId);
  assert.equal(after.uid, before.uid); assert.equal(after.text, before.text); assert.deepEqual(after.people, before.people);
  assert.equal(after.updatedAt, before.updatedAt); assert.notEqual(after.version, before.version);
  assert.equal((await listNotes(f.resources, { subject: f.root.metadata.uid })).items.length, 0);
  assert.equal((await listNotes(f.resources, { subject: child.metadata.uid })).items.length, 1);
  await assert.rejects(moveNote(f.resources, f.read(), { ...initial, subject: resourceRef(f.root), reason: "stale" }), /version conflict/);
  await assert.rejects(moveNote(f.resources, f.read(), { ...moved, subject: resourceRef(outsider), reason: "outside" }), /outside/);
  const latest = await f.get(initial.noteId);
  await assert.rejects(f.resources.replace(latest, { ...latest.spec, subject: resourceRef(f.root) }, latest.status), /organization reason/);
});

test("move_note rechecks ancestor changes in the write transaction and supports Work subjects", async t => {
  const f = await setup(t);
  const child = await createWithSummary<TopicSpec, TopicStatus>(f.resources, TOPIC_TYPE, { name: "child", spec: { id: "child", parentRef: resourceRef(f.root) }, status: { summary: "", receipts: [] } });
  const routine = await createWithSummary(f.resources, ROUTINE_TYPE, { name: "work", spec: { title: "Watch", instruction: "Watch", trigger: { cron: null, event: "tick", timezone: "UTC" } }, status: { topic: resourceRef(f.root), summary: "" } });
  const initial = await f.note({ text: "A continuing matter" }, "start");
  const moved = await moveNote(f.resources, f.read(), { ...initial, subject: resourceRef(routine), reason: "Delegated" });
  const client: ResourceClient = { ...f.resources, async replace(resource, spec, status) {
    await f.resources.replace(child, { id: "child" }, child.status);
    return f.resources.replace(resource, spec, status);
  } };
  await assert.rejects(moveNote(client, f.read(), { ...moved, subject: resourceRef(child), reason: "Scope changed" }), /outside/);
  assert.equal((await f.get(initial.noteId)).spec.subject.uid, routine.metadata.uid);
});

test("Topic silence retains knowledge; capacity evicts oldest safe candidates and protects new dependencies", async t => {
  const f = await setup(t), old = "2000-01-01T00:00:00.000Z";
  await f.resources.patchStatus(f.read(), { execution: null, lastInputAt: old });
  await collectTopic(f.context, f.read());
  assert.ok(f.read(), "silence alone never deletes a Topic");
  const protectedTopic = await f.aide.topics.ensure("protected"), newer = await f.aide.topics.ensure("newer");
  await f.resources.patchStatus(protectedTopic, { lastInputAt: "1990-01-01T00:00:00.000Z" });
  await f.resources.patchStatus(newer, { lastInputAt: "2010-01-01T00:00:00.000Z" });
  await f.resources.create(INPUT_TYPE, { name: "pending", spec: { origin: "chief", originId: "test", text: "Unprocessed", attention: InputAttention.Normal },
    status: { topic: resourceRef(protectedTopic), assess: {} } });
  const count = f.aide.topics.list().length;
  f.aide.topics.resources.storage.configure(ResourceStorageConfigSchema.parse({ lowWatermark: 0.95, highWatermark: 0.99, kinds: { "aide.dev/Topic": { maxCount: count } } }));
  await assert.rejects(f.aide.topics.ensure("new-arrival"), /capacity/);
  await collectResources(f.aide.topics.resources.storage);
  await f.aide.topics.ensure("new-arrival");
  assert.equal(f.aide.topics.resource("knowledge"), undefined, "oldest eligible candidate is reclaimed");
  assert.ok(f.aide.topics.resource("protected"), "new pending dependency blocks even an older candidate");
  assert.ok(f.aide.topics.resource("newer"));
});

test("root knowledge needs explicit release; unseen Note changes invalidate approval", async t => {
  const f = await setup(t);
  await patchSummary(f.resources, f.read(), { summary: "Lasting knowledge" });
  const tools = topicTools(f.aide.personal.store, f.read, log);
  const release = tools.find(t => t.name === "release_topic")!;
  const call = (version: string) => release.execute("release", { version, reason: "Retained elsewhere" }, undefined, undefined, {} as never);
  await call(reclamationVersion(f.read(), f.aide.topics.resources));
  const prior = f.read().status.reclamation!.version;
  await f.note({ text: "A new unresolved matter" }, "new-evidence");
  assert.notEqual(reclamationVersion(f.read(), f.aide.topics.resources), prior);
  await assert.rejects(call(prior), /understanding changed/);
});

test("full Topic capacity preserves root knowledge until a current explicit release", async t => {
  const f = await setup(t);
  await patchSummary(f.resources, f.read(), { summary: "Lasting knowledge", execution: null });
  const count = f.aide.topics.list().length;
  f.aide.topics.resources.storage.configure(ResourceStorageConfigSchema.parse({ kinds: { "aide.dev/Topic": { maxCount: count } } }));
  await assert.rejects(f.aide.topics.ensure("overflow"), /capacity exhausted/);
  assert.ok(f.read());
  await f.resources.patchStatus(f.read(), { execution: { id: "release", startedAt: new Date().toISOString() } });
  const release = topicTools(f.aide.personal.store, f.read, log).find(t => t.name === "release_topic")!;
  await release.execute("release", { version: reclamationVersion(f.read(), f.aide.topics.resources), reason: "Safe knowledge retained elsewhere" }, undefined, undefined, {} as never);
  await f.resources.patchStatus(f.read(), { execution: null });
  await collectResources(f.aide.topics.resources.storage);
  await f.aide.topics.ensure("overflow");
  assert.equal(f.read(), undefined);
});

test("idle Chief release belongs to the serial agent controller; intake cannot close it", async t => {
  const f = await setup(t);
  await f.resources.replace(f.read(), { ...f.read().spec, review: { enabled: false } }, { ...f.read().status, execution: null,
    agent: { harness: "chief", sessionId: "idle-native" }, lastInputAt: "2000-01-01T00:00:00.000Z" });
  let closes = 0;
  const execution: any = { verbs: { async harness(args: any) {
    assert.equal(args.operation, "close"); closes++;
    return { state: "success", value: { outcome: "accepted" } };
  } } };
  await collectTopic(f.context, f.read());
  assert.equal(closes, 0); assert.ok(f.read().status.agent);
  await reconcileChief(f.context, execution, f.read());
  assert.equal(closes, 1); assert.equal(f.read().status.agent, undefined); assert.ok(f.read());
});

test("pressure review request tolerates unrelated Topic writes and commits its check atomically", async t => {
  const f = await setup(t);
  await f.resources.replace(f.read(), { ...f.read().spec, review: { enabled: false } }, { ...f.read().status, execution: null });
  const agenda = await maintenanceAgenda(f.resources, []);
  let injected = false;
  const resources: ResourceClient = { ...f.resources, async commit(writes) {
    if (!injected) {
      injected = true;
      await f.resources.patchStatus(f.read(), { lastError: "preserved" });
    }
    return f.resources.commit(writes);
  } };
  const input = await createReviewInput({ ...f.context, resources }, f.read(), new Date().toISOString(), agenda, "aide:review", "note_pressure");
  assert.equal(input.status.assess!.topic!.uid, f.root.metadata.uid);
  assert.equal(f.read().status.lastError, "preserved");
  assert.ok(f.read().status.reviewCheckedAt);
});

for (const race of ["parent", "execution", "disabled", "schedule-failure"] as const)
test(`review request rolls back on ${race} at commit`, async t => {
  const f = await setup(t);
  await f.resources.patchStatus(f.read(), { execution: null });
  const parent = await f.aide.topics.ensure("new-root");
  const agenda = await maintenanceAgenda(f.resources, []);
  const resources: ResourceClient = { ...f.resources, async commit(writes) {
    if (race === "parent") await f.resources.replace(f.read(), { ...f.read().spec, parentRef: resourceRef(parent) }, f.read().status);
    if (race === "execution") await f.resources.patchStatus(f.read(), { execution: { id: "other", startedAt: new Date().toISOString() } });
    if (race === "disabled") await f.resources.replace(f.read(), { ...f.read().spec, review: { enabled: false } }, f.read().status);
    return f.resources.commit(race === "schedule-failure" ? [...writes, { operation: "patchStatus", resource: f.read(), patch: { unknown: true } }] : writes);
  } };
  await assert.rejects(createReviewInput({ ...f.context, resources }, f.read(), new Date().toISOString(), agenda, "aide:review"), race === "schedule-failure" ? /unknown|Unrecognized/ : /idle enabled root/);
  assert.equal(f.aide.topics.inputStore.list().length, 0);
  assert.equal(f.read().status.reviewCheckedAt ?? null, null);
  assert.equal(f.read().status.nextAbsorbAt, undefined);
});

for (const sameDue of [true, false])
test(`racing review requests reuse one pending Input (same due: ${sameDue})`, async t => {
  const f = await setup(t);
  await f.resources.patchStatus(f.read(), { execution: null });
  const agenda = await maintenanceAgenda(f.resources, []), due = new Date().toISOString();
  const [a, b] = await Promise.all([
    createReviewInput(f.context, f.read(), due, agenda, "aide:review", "note_pressure"),
    createReviewInput(f.context, f.read(), sameDue ? due : "2000-01-01T00:00:00.000Z", agenda, "aide:review", "note_pressure"),
  ]);
  assert.equal(a.metadata.uid, b.metadata.uid);
  assert.equal(f.aide.topics.inputStore.list().length, 1);
  assert.ok(f.read().status.reviewCheckedAt);
});

/** @case Recent projection never decodes retained history outside its index page. */
test("recent Note projection reads at most 40 objects and no full list", async t => {
  const f = await setup(t);
  for (let i = 0; i < 45; i++) await f.note({ text: `matter ${i}` }, String(i));
  const storage = f.aide.topics.resources.storage, read = storage.read.bind(storage);
  let reads = 0;
  storage.read = (...args) => { reads++; return read(...args); };
  try {
    const recent = notes(f.aide.topics.resources, f.root.metadata.uid, "subject");
    assert.equal(recent.length, 40); assert.equal(reads, 40);
  } finally { storage.read = read; }
});

test("Note nature and maxChars are optional metadata; budgets are soft for ordinary and summary Notes", async t => {
  const f = await setup(t);
  const { upsertNote } = await import("../plugins/personal/note/service.ts");
  const { summarizeTopic } = await import("../plugins/personal/topic/state.ts");
  const { contentVersion } = await import("../plugins/personal/context-write.ts");
  const created = await f.note({ text: "知".repeat(600), nature: "procedural", maxChars: 256 }, "budget");
  const note = await readNote(f.resources, created.noteId);
  assert.equal(note.text.length, 600); assert.equal(note.nature, "procedural"); assert.equal(note.maxChars, 256);
  const updated = await upsertNote(f.resources, f.read(), { ...created, nature: "semantic" }, "classify");
  assert.equal(updated.overBudget, true); assert.equal(updated.chars, 600);
  const latest = await readNote(f.resources, created.noteId);
  assert.equal(latest.text, note.text); assert.equal(latest.maxChars, 256);
  await summarizeTopic(f.resources, f.read(), "live", { summary: "长".repeat(600), nature: "semantic", maxChars: 256, version: contentVersion(f.read()) }, 256);
  const summary = (await listNotes(f.resources, { subject: f.root.metadata.uid })).items.find(n => n.summaryOf)!;
  assert.equal(summary.maxChars, 256); assert.equal(summary.nature, "semantic");
  assert.equal((await readNote(f.resources, summary.id)).text.length, 600);
  await assert.rejects(upsertNote(f.resources, f.read(), { noteId: created.noteId, version: latest.version, nature: "static" }, "bad"));
});

test("prune and retire enforce versions, active ownership and summary lifetime while preserving citations", async t => {
  const f = await setup(t);
  const { pruneNote, retireNote } = await import("../plugins/personal/note/service.ts");
  const { noteTextVersion } = await import("../plugins/personal/note/model.ts");
  const { writeSummary } = await import("../plugins/personal/note/summary.ts");
  const source = await f.note({ text: "Verified long-term fact. Temporary duplicate details.", nature: "semantic" }, "source");
  const destination = await f.note({ text: "Verified long-term fact." }, "destination");
  await assert.rejects(pruneNote(f.resources, f.read(), { ...source, text: "", reason: "empty" }, "empty"));
  await assert.rejects(pruneNote(f.resources, f.read(), { ...source, text: "x".repeat(100), reason: "grow" }, "grow"), /shorter/);
  const pruned = await pruneNote(f.resources, f.read(), { ...source, text: "Temporary duplicate details.", reason: `Fact retained in ${destination.noteId}` }, "prune");
  await assert.rejects(retireNote(f.resources, f.read(), { ...source, reason: "stale" }), /version conflict/);
  const before = await f.get(source.noteId);
  await reconcileNote(f.context, before);
  const retired = await retireNote(f.resources, f.read(), { noteId: source.noteId, version: pruned.version, reason: "No independent value" });
  const after = await f.get(source.noteId);
  assert.equal(after.spec.text, before.spec.text); assert.equal(after.status.updatedAt, before.status.updatedAt);
  assert.equal(noteVersion(after), noteVersion(before)); assert.equal(noteTextVersion(after), noteTextVersion(before));
  assert.equal(retired.retired?.reason, "No independent value");
  assert.equal((await readNote(f.resources, source.noteId)).retired?.writer.executionId, "live");
  assert.ok(!(await listNotes(f.resources, { subject: f.root.metadata.uid })).items.some(n => n.id === source.noteId));
  assert.ok(!notes(f.aide.topics.resources, f.root.metadata.uid).some(n => n.id === source.noteId));
  await assert.rejects(f.note({ noteId: source.noteId, version: retired.version, text: "revive" }, "revive"), /retired/);
  const summary = await writeSummary(f.resources, f.read(), { text: "Stable summary with repeated detail", maxChars: 256 }, { resource: resourceRef(f.read()) as typeof before.spec.subject & { kind: "Topic" }, executionId: "live" });
  const summaryRef = { noteId: summary.summaryNote!.id, version: summary.summaryNote!.version };
  await assert.rejects(retireNote(f.resources, f.read(), { ...summaryRef, reason: "discard" }), /subject still exists/);
  const summaryPruned = await pruneNote(f.resources, f.read(), { ...summaryRef, text: "Stable summary", reason: "Remove duplication" }, "prune-summary");
  assert.equal(f.read().status.summaryRevision, summaryPruned.version);
  const outsider = await f.aide.topics.ensure("outside-retire");
  const other = await f.resources.patchStatus(outsider, { execution: { id: "outside", startedAt: new Date().toISOString() } });
  await assert.rejects(retireNote(f.resources, other, { ...destination, reason: "outside" }), /outside/);
});

test("Note pressure counts direct active Notes and includes oversized summaries", async t => {
  const f = await setup(t);
  const { refreshNotePressure, dueNotePressure, recordNotePressure } = await import("../plugins/personal/note/pressure.ts");
  const { retireNote } = await import("../plugins/personal/note/service.ts");
  const { writeSummary } = await import("../plugins/personal/note/summary.ts");
  await f.resources.replace(f.read(), { ...f.read().spec, maxNotes: 1 }, f.read().status);
  await f.note({ text: "first" }, "one");
  const second = await f.note({ text: "second" }, "two");
  const child = await createWithSummary<TopicSpec, TopicStatus>(f.resources, TOPIC_TYPE, { name: "pressure-child", spec: { id: "pressure-child", parentRef: resourceRef(f.root) }, status: {} });
  await f.note({ subject: resourceRef(child), text: "child" }, "child-note");
  await refreshNotePressure(f.context, f.read());
  let agenda = await dueNotePressure(f.resources, f.read());
  assert.equal(agenda.length, 1); assert.equal(agenda[0]!.pressure.count, 2);
  await recordNotePressure(f.resources, agenda, 60, "live");
  assert.equal((await dueNotePressure(f.resources, f.read())).length, 0, "unchanged no-progress work must not loop");
  await retireNote(f.resources, f.read(), { ...second, reason: "redundant" });
  await refreshNotePressure(f.context, f.read());
  assert.equal(f.read().status.notePressure, undefined);
  await writeSummary(f.resources, f.read(), { text: "s".repeat(300), maxChars: 256 });
  await refreshNotePressure(f.context, f.read());
  agenda = await dueNotePressure(f.resources, f.read());
  assert.equal(agenda[0]!.pressure.count, 1); assert.equal(agenda[0]!.pressure.oversized.length, 1);
  await recordNotePressure(f.resources, agenda, 60);
  assert.equal((await dueNotePressure(f.resources, f.read())).length, 0, "failed or interrupted rounds respect retry delay");
  assert.equal((await dueNotePressure(f.resources, f.read(), Date.now() + 61_000)).length, 1);
});

test("reducing an older Note outside the count sample continues consolidation without scanning history", async t => {
  const f = await setup(t);
  const { refreshNotePressure, dueNotePressure, recordNotePressure } = await import("../plugins/personal/note/pressure.ts");
  const { retireNote } = await import("../plugins/personal/note/service.ts");
  await f.resources.replace(f.read(), { ...f.read().spec, maxNotes: 1 }, f.read().status);
  const older = await f.note({ text: "older redundant matter" }, "older");
  const oldResource = await f.get(older.noteId);
  await f.resources.patchStatus(oldResource, { updatedAt: "2000-01-01T00:00:00.000Z" });
  const oldVersion = noteVersion(await f.get(older.noteId));
  for (let i = 0; i < 3; i++) await f.note({ text: `recent ${i}` }, `recent-${i}`);
  await refreshNotePressure(f.context, f.read());
  const agenda = await dueNotePressure(f.resources, f.read());
  assert.equal(agenda[0]!.pressure.count, 2); assert.equal(agenda[0]!.pressure.truncated, true);
  assert.ok(!agenda[0]!.pressure.notes.some(n => n.noteId === older.noteId));
  await retireNote(f.resources, f.read(), { noteId: older.noteId, version: oldVersion, reason: "no independent value" });
  await refreshNotePressure(f.context, f.read());
  assert.equal(f.read().status.notePressure!.version, agenda[0]!.pressure.version, "threshold sample stayed unchanged");
  await recordNotePressure(f.resources, agenda, 60, "live");
  assert.equal((await dueNotePressure(f.resources, f.read(), Date.now() + 61_000)).length, 1, "real reduction schedules another bounded pass");
  await recordNotePressure(f.resources, agenda, 60, "no-reduction-execution");
  assert.equal((await dueNotePressure(f.resources, f.read(), Date.now() + 61_000)).length, 0, "no reduction stops unchanged work");
});


test("stored per-Note review metadata is discarded without changing content or age", async t => {
  const f = await setup(t), n = await f.note({ text: "Existing knowledge" }, "legacy");
  const { NoteStatusSchema } = await import("../plugins/personal/note/model.ts");
  const { TopicDefinition } = await import("../plugins/personal/topic/definition.ts");
  const { noteTools } = await import("../plugins/personal/note/tools.ts");
  const before = await f.get(n.noteId);
  const status = NoteStatusSchema.parse({ ...before.status, reviewTopic: resourceRef(f.root), reviewed: { version: n.version, at: before.status.updatedAt } });
  assert.deepEqual(status, before.status);
  assert.equal(noteVersion({ ...before, status }), n.version);
  const topicStatus = TopicDefinition.schema.status.parse({ ...f.read().status, noteReviewQueue: [n] });
  assert.deepEqual(topicStatus, f.read().status);
  const names = noteTools(f.resources, f.read).map(t => t.name);
  assert.ok(!names.includes("review_notes"));
  assert.ok(names.includes("prune_note")); assert.ok(names.includes("retire_note"));
  assert.equal(await reconcileNote(f.context, before), undefined);
  assert.deepEqual(await f.get(n.noteId), before);
});
