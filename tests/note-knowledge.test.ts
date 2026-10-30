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
import { moveNote, reviewNotes } from "../plugins/personal/note/operations.ts";
import { listNotes, notes } from "../plugins/personal/note/query.ts";
import { NOTE_TYPE, noteVersion, type NoteSpec, type NoteStatus } from "../plugins/personal/note/model.ts";
import { pendingNoteReviews, reconcileNote, registerNotes } from "../plugins/personal/note/reconcile.ts";
import { collectTopic } from "../plugins/personal/topic/lifecycle.ts";
import { ResourceStorageConfigSchema } from "../src/host/resource/storage.ts";
import { topicTools } from "../plugins/personal/topic/tools.ts";
import { reclamationVersion } from "../plugins/personal/topic/retention.ts";
import { ROUTINE_TYPE } from "../plugins/personal/routine/model.ts";
import { INPUT_TYPE, InputAttention } from "../plugins/personal/input/model.ts";
import { reconcileChief } from "../plugins/personal/topic/reconcile.ts";
import { assessInput } from "../plugins/personal/topic/assess.ts";
const log = pino({ level: "silent" });
async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-knowledge-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected inference"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const original = await aide.topics.ensure("knowledge");
  const root = await resources.patchStatus(original, { execution: { id: "live", startedAt: new Date().toISOString() } });
  const read = () => aide.topics.resource("knowledge")!;
  const note = (raw: unknown, callId: string) => upsertTopicNote(resources, read(), "live", raw, callId);
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
  const child = await f.resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, { name: "child", spec: { id: "child", parentRef: resourceRef(f.root) }, status: { summary: "", receipts: [] } });
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
  const child = await f.resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, { name: "child", spec: { id: "child", parentRef: resourceRef(f.root) }, status: { summary: "", receipts: [] } });
  const routine = await f.resources.create(ROUTINE_TYPE, { name: "work", spec: { title: "Watch", instruction: "Watch", trigger: { cron: null, event: "tick", timezone: "UTC" } }, status: { topic: resourceRef(f.root), summary: "" } });
  const initial = await f.note({ text: "A continuing matter" }, "start");
  const moved = await moveNote(f.resources, f.read(), { ...initial, subject: resourceRef(routine), reason: "Delegated" });
  const client: ResourceClient = { ...f.resources, async replace(resource, spec, status) {
    await f.resources.replace(child, { id: "child" }, child.status);
    return f.resources.replace(resource, spec, status);
  } };
  await assert.rejects(moveNote(client, f.read(), { ...moved, subject: resourceRef(child), reason: "Scope changed" }), /outside/);
  assert.equal((await f.get(initial.noteId)).spec.subject.uid, routine.metadata.uid);
});

test("Note review is versioned, bounded and follows current roots without refreshing content age", async t => {
  const f = await setup(t);
  for (let i = 0; i < 21; i++) {
    const n = await f.note({ text: `Matter ${i}` }, String(i));
    await reconcileNote(f.context, await f.get(n.noteId));
  }
  assert.equal(f.read().status.noteReviewQueue!.length, 20);
  const pending = await pendingNoteReviews(f.context, f.read()), ref = pending[0]!, before = await f.get(ref.noteId);
  await reviewNotes(f.resources, f.read(), { notes: [ref] });
  const reviewed = await f.get(ref.noteId);
  assert.equal(noteVersion(reviewed), ref.version); assert.equal(reviewed.status.updatedAt, before.status.updatedAt);
  assert.equal((await pendingNoteReviews(f.context, f.read())).length, 19);
  const updated = await f.note({ ...ref, text: "New verified evidence" }, "change");
  await assert.rejects(reviewNotes(f.resources, f.read(), { notes: [ref] }), /changed before review/);
  await reconcileNote(f.context, await f.get(ref.noteId));
  assert.ok((await pendingNoteReviews(f.context, f.read())).some(n => n.version === updated.version));
  const newRoot = await f.aide.topics.ensure("new-root");
  await f.resources.replace(f.read(), { ...f.read().spec, parentRef: resourceRef(newRoot) }, f.read().status);
  await reconcileNote(f.context, await f.get(ref.noteId));
  assert.ok(f.aide.topics.resource("new-root")!.status.noteReviewQueue?.some(n => n.noteId === ref.noteId));
});

test("Work Notes are routed to the responsible root's review queue", async t => {
  const f = await setup(t);
  const work = await f.resources.create(ROUTINE_TYPE, { name: "work", spec: { title: "Watch", instruction: "Watch", trigger: { cron: null, event: "tick", timezone: "UTC" } }, status: { topic: resourceRef(f.root), summary: "" } });
  const n = await f.note({ text: "Verification finding", subject: resourceRef(work) }, "work-note");
  await reconcileNote(f.context, await f.get(n.noteId));
  assert.equal(f.read().status.noteReviewQueue![0]!.noteId, n.noteId);
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
  f.aide.topics.resources.storage.configure(ResourceStorageConfigSchema.parse({ lowWatermark: 0.95, kinds: { "aide.dev/Topic": { maxCount: count } } }));
  await f.aide.topics.ensure("new-arrival");
  assert.equal(f.aide.topics.resource("knowledge"), undefined, "oldest eligible candidate is reclaimed");
  assert.ok(f.aide.topics.resource("protected"), "new pending dependency blocks even an older candidate");
  assert.ok(f.aide.topics.resource("newer"));
});

test("root knowledge needs explicit release; unseen Note changes invalidate approval", async t => {
  const f = await setup(t);
  await f.resources.patchStatus(f.read(), { summary: "Lasting knowledge" });
  const tools = topicTools(f.aide.personal.store, f.read, log);
  const release = tools.find(t => t.name === "release_topic")!;
  const call = (version: string) => release.execute("release", { version, reason: "Retained elsewhere" }, undefined, undefined, {} as never);
  await call(reclamationVersion(f.read(), f.aide.topics.resources));
  const prior = f.read().status.reclamation!.version;
  await f.note({ text: "A new unresolved matter" }, "new-evidence");
  assert.notEqual(reclamationVersion(f.read(), f.aide.topics.resources), prior);
  await assert.rejects(call(prior), /understanding changed/);
});

test("root-local Notes trigger an internal review even with idle review off, and confirmed versions do not repeat", async t => {
  const f = await setup(t);
  const n = await f.note({ text: "A concrete incident is now resolved; assess lasting lessons" }, "matter");
  await reconcileNote(f.context, await f.get(n.noteId));
  await f.resources.replace(f.read(), { ...f.read().spec, review: { enabled: false } }, { ...f.read().status, execution: null });
  let prompts = 0;
  const execution: any = { executionId: "note-review", withContext() { return this; }, verbs: { async harness(args: any) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "chief", sessionId: "native" } };
    prompts++;
    assert.match(args.prompt, /Matter Notes await review/);
    const current = f.read();
    await reviewNotes(f.resources, current, { notes: [{ noteId: n.noteId, version: n.version }] });
    const inputs = f.aide.topics.inputStore.list().filter(i => i.status.assess?.executionId === "note-review");
    assert.equal(inputs.length, 1); assert.equal(inputs[0]!.spec.origin, "aide:review");
    await assessInput(f.resources, current, "note-review", { inputId: inputs[0]!.metadata.name, summary: "Reviewed; no lasting conclusion needed" });
    return { state: "success", value: { result: { stopReason: "end_turn" } } };
  } } };
  await reconcileChief(f.context, execution, f.read());
  assert.equal(prompts, 1);
  await reconcileChief(f.context, execution, f.read());
  assert.equal(prompts, 1); assert.equal(f.read().status.noteReviewQueue!.length, 0);
});

test("full Topic capacity preserves root knowledge until a current explicit release", async t => {
  const f = await setup(t);
  await f.resources.patchStatus(f.read(), { summary: "Lasting knowledge", execution: null });
  const count = f.aide.topics.list().length;
  f.aide.topics.resources.storage.configure(ResourceStorageConfigSchema.parse({ kinds: { "aide.dev/Topic": { maxCount: count } } }));
  await assert.rejects(f.aide.topics.ensure("overflow"), /capacity exhausted/);
  assert.ok(f.read());
  await f.resources.patchStatus(f.read(), { execution: { id: "release", startedAt: new Date().toISOString() } });
  const release = topicTools(f.aide.personal.store, f.read, log).find(t => t.name === "release_topic")!;
  await release.execute("release", { version: reclamationVersion(f.read(), f.aide.topics.resources), reason: "Safe knowledge retained elsewhere" }, undefined, undefined, {} as never);
  await f.resources.patchStatus(f.read(), { execution: null });
  await f.aide.topics.ensure("overflow");
  assert.equal(f.read(), undefined);
});

test("a review batch rolls back if a Note changes before the transaction", async t => {
  const f = await setup(t), a = await f.note({ text: "First matter" }, "a"), b = await f.note({ text: "Second matter" }, "b");
  const client: ResourceClient = { ...f.resources, async commit(writes) {
    await f.note({ ...b, text: "New evidence for second matter" }, "change");
    return f.resources.commit(writes);
  } };
  await assert.rejects(reviewNotes(client, f.read(), { notes: [a, b] }), /changed before review/);
  assert.equal((await f.get(a.noteId)).status.reviewed, undefined);
  assert.equal((await f.get(b.noteId)).status.reviewed, undefined);
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


test("review_notes confirms a set idempotently, including racing first receipts", async t => {
  const f = await setup(t), n = await f.note({ text: "Matter" }, "one");
  await assert.rejects(reviewNotes(f.resources, f.read(), { notes: [n, { ...n, version: "different" }] }), /Conflicting review versions/);
  assert.equal((await f.get(n.noteId)).status.reviewed, undefined);
  const results = await Promise.all([reviewNotes(f.resources, f.read(), { notes: [n, n] }), reviewNotes(f.resources, f.read(), { notes: [n] })]);
  assert.deepEqual(results, [{ reviewed: 1 }, { reviewed: 1 }]);
  const first = await f.get(n.noteId);
  await reviewNotes(f.resources, f.read(), { notes: [n] });
  assert.deepEqual(await f.get(n.noteId), first, "repeat changes neither receipt time nor resource version");
  const staleActor = f.read();
  await f.resources.patchStatus(staleActor, { execution: null });
  await assert.rejects(reviewNotes(f.resources, staleActor, { notes: [n] }), /no longer active/);
});

test("review_notes re-reads unrelated writes but never substitutes newly edited content", async t => {
  const f = await setup(t), n = await f.note({ text: "Matter" }, "one");
  let injected = false;
  const client: ResourceClient = { ...f.resources, async commit(writes) {
    if (!injected) { injected = true; await f.resources.patchMetadata(await f.get(n.noteId), { labels: { observed: "yes" } }); }
    return f.resources.commit(writes);
  } };
  await reviewNotes(client, f.read(), { notes: [n] });
  assert.equal((await f.get(n.noteId)).metadata.labels?.observed, "yes");
  assert.equal((await f.get(n.noteId)).status.reviewed!.version, n.version);
});

test("review_notes checks current ancestry even when its receipt is already present", async t => {
  const f = await setup(t);
  const child = await f.resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, { name: "child", spec: { id: "child", parentRef: resourceRef(f.root) }, status: { summary: "", receipts: [] } });
  const n = await f.note({ text: "Child matter", subject: resourceRef(child) }, "child");
  await reviewNotes(f.resources, f.read(), { notes: [n] });
  const client: ResourceClient = { ...f.resources, async commit(writes) {
    await f.resources.replace(child, { id: "child" }, child.status);
    return f.resources.commit(writes);
  } };
  await assert.rejects(reviewNotes(client, f.read(), { notes: [n] }), /outside/);
});

test("Note review request tolerates unrelated Topic writes and commits cooldown atomically", async t => {
  const f = await setup(t), n = await f.note({ text: "Matter" }, "one");
  await f.resources.replace(f.read(), { ...f.read().spec, review: { enabled: false } }, { ...f.read().status, execution: null });
  const agenda = await maintenanceAgenda(f.resources, []);
  let injected = false;
  const resources: ResourceClient = { ...f.resources, async commit(writes) {
    if (!injected) {
      injected = true;
      await f.resources.patchStatus(f.read(), { noteReviewQueue: [n], lastError: "preserved" });
    }
    return f.resources.commit(writes);
  } };
  const input = await createReviewInput({ ...f.context, resources }, f.read(), new Date().toISOString(), agenda, "aide:review", [n]);
  assert.equal(input.status.assess!.topic!.uid, f.root.metadata.uid);
  assert.deepEqual(f.read().status.noteReviewQueue, [n]);
  assert.equal(f.read().status.lastError, "preserved");
  assert.equal(f.read().status.absorbAttempts, 1);
  assert.ok(Date.parse(f.read().status.nextAbsorbAt!) > Date.now());
});

for (const race of ["parent", "execution", "disabled", "schedule-failure"] as const)
test(`review request rolls back on ${race} at commit`, async t => {
  const f = await setup(t), note = await f.note({ text: "Matter" }, "rollback");
  await f.resources.patchStatus(f.read(), { execution: null });
  const parent = await f.aide.topics.ensure("new-root");
  const agenda = await maintenanceAgenda(f.resources, []);
  const resources: ResourceClient = { ...f.resources, async commit(writes) {
    if (race === "parent") await f.resources.replace(f.read(), { ...f.read().spec, parentRef: resourceRef(parent) }, f.read().status);
    if (race === "execution") await f.resources.patchStatus(f.read(), { execution: { id: "other", startedAt: new Date().toISOString() } });
    if (race === "disabled") await f.resources.replace(f.read(), { ...f.read().spec, review: { enabled: false } }, f.read().status);
    return f.resources.commit(race === "schedule-failure" ? [...writes, { operation: "patchStatus", resource: f.read(), patch: { unknown: true } }] : writes);
  } };
  await assert.rejects(createReviewInput({ ...f.context, resources }, f.read(), new Date().toISOString(), agenda, "aide:review", race === "schedule-failure" ? [note] : []), race === "schedule-failure" ? /unknown|Unrecognized/ : /idle enabled root/);
  assert.equal(f.aide.topics.inputStore.list().length, 0);
  assert.equal(f.read().status.reviewCheckedAt ?? null, null);
  assert.equal(f.read().status.nextAbsorbAt, undefined);
});

for (const sameDue of [true, false])
test(`racing review requests reuse one pending Input (same due: ${sameDue})`, async t => {
  const f = await setup(t), n = await f.note({ text: "Matter" }, "one");
  await f.resources.patchStatus(f.read(), { execution: null });
  const agenda = await maintenanceAgenda(f.resources, []), due = new Date().toISOString();
  const [a, b] = await Promise.all([
    createReviewInput(f.context, f.read(), due, agenda, "aide:review", [n]),
    createReviewInput(f.context, f.read(), sameDue ? due : "2000-01-01T00:00:00.000Z", agenda, "aide:review", [n]),
  ]);
  assert.equal(a.metadata.uid, b.metadata.uid);
  assert.equal(f.aide.topics.inputStore.list().length, 1);
  assert.equal(f.read().status.absorbAttempts, 1);
});

/** @case Recent projection never decodes retained history outside its index page. */
test("recent Note projection reads at most 40 objects and no full list", async t => {
  const f = await setup(t);
  for (let i = 0; i < 45; i++) await f.note({ text: `matter ${i}` }, String(i));
  const storage = f.aide.topics.resources.storage, read = storage.read.bind(storage);
  let reads = 0;
  storage.read = (...args) => { reads++; return read(...args); };
  try {
    const recent = notes(f.aide.topics.resources, f.root.metadata.uid);
    assert.equal(recent.length, 40); assert.equal(reads, 40);
  } finally { storage.read = read; }
});

/** @case Queue slots wake waiting Notes; a missed ancestor event is repaired without an active content writer. */
test("Note dependency watches refill capacity and ancestry repair survives a finished writer", async t => {
  const f = await setup(t);
  const entries: import("../plugins/personal/note/model.ts").NoteResource[] = [];
  for (let i = 0; i < 21; i++) {
    const created = await f.note({ text: `matter ${i}` }, String(i));
    const note = await f.get(created.noteId); entries.push(note);
    assert.deepEqual(await reconcileNote(f.context, note), { requeueAfterMs: 15 * 60_000 });
  }
  let watches: readonly import("@compforge/aide-plugin").Watch[] = [];
  registerNotes({ ...f.context, controllers: { register(definition: any) { watches = definition.watches; } } } as PluginContext);
  const before = f.read();
  await reviewNotes(f.resources, before, { notes: before.status.noteReviewQueue!.slice(0, 1) });
  const after = await f.resources.patchStatus(f.read(), { noteReviewQueue: await pendingNoteReviews(f.context, f.read()) });
  const watch = watches.find(w => w.resourceType.kind === "Topic")!;
  const requests = await watch.handler.update({ oldObject: before, newObject: after });
  assert.ok(requests.some(r => r.name === entries[20]!.metadata.name)); assert.ok(requests.length <= 40);
  for (const request of requests) await reconcileNote(f.context, await f.get(request.name));
  assert.equal(f.read().status.noteReviewQueue!.length, 20);
  assert.ok(f.read().status.noteReviewQueue!.some(r => r.noteId === entries[20]!.metadata.name));
  const newRoot = await f.aide.topics.ensure("repair-root");
  await f.resources.patchStatus(f.read(), { execution: null });
  await f.resources.replace(f.read(), { ...f.read().spec, parentRef: resourceRef(newRoot) }, f.read().status);
  const pending = await f.get(entries[20]!.metadata.name), version = noteVersion(pending);
  await reconcileNote(f.context, pending);
  assert.equal((await f.get(pending.metadata.name)).status.reviewTopic?.uid, newRoot.metadata.uid);
  assert.equal(noteVersion(await f.get(pending.metadata.name)), version);
});
