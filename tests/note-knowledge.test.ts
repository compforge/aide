import { confirmCuratedNotes } from "../plugins/personal/note/confirm.ts";
import { deliverInput, routeTo } from "./input-state-fixture.ts";
import { upsertOngoing, readOngoing } from "../plugins/personal/ongoing/service.ts";
import { prepareOngoingCheck } from "./maintenance-fixture.ts";
import { topicPolicy } from "../plugins/personal/topic/config.ts";
import { fixtureMe } from "./address-fixture.ts";
import { fixtureGateRef } from "./summary-fixture.ts";
import { collectResources } from "./fixtures/resource-gc.ts";
import { createWithSummary, patchSummary } from "./summary-fixture.ts";
import { createMaintenanceInput } from "../plugins/personal/secretary/input.ts";
import { maintenanceAgenda } from "../plugins/personal/secretary/maintenance.ts";
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
import { collectTopic } from "../plugins/personal/chief/session.ts";
import { ResourceStorageConfigSchema } from "../src/host/resource/storage.ts";
import { emptyConnectors } from "../src/connector/client.ts";
import { chiefTools } from "../plugins/personal/chief/agent/chief-tools.ts";
import { chiefNoteTools } from "../plugins/personal/chief/agent/note-tools.ts";
import { toolsForInput } from "../plugins/personal/chief/agent/input-tools.ts";
import { topicTools } from "../plugins/personal/chief/agent/topic-tools.ts";
import { reclamationVersion } from "../plugins/personal/topic/retention.ts";
import { ROUTINE_TYPE } from "../plugins/personal/routine/model.ts";
import { INPUT_TYPE, InputAttention } from "../plugins/personal/input/model.ts";
import { reconcileChief } from "../plugins/personal/chief/reconcile.ts";
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
  return { aide, resources, root, read, note, get, context, home };
}

test("Note discovery covers retained history beyond recent with bounded search pages", async t => {
  const f = await setup(t), ids = new Set<string>();
  for (let i = 0; i < 45; i++) ids.add((await f.note({ nature: "semantic", text: `matter-${i}: ${"x".repeat(1000)}` }, String(i))).noteId);
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

test("Chief Note writes honor the selected Input for new and existing summaries", async t => {
  const f = await setup(t);
  const write = (origin: import("../plugins/personal/input/model.ts").InputOrigin, args: unknown) =>
    upsertTopicNote(f.resources, f.read(), "live", args, "call", 4000, origin);
  const create = { summaryOf: resourceRef(f.read()), text: "Verified scope" };
  for (const origin of ["channel", "chief", "source", "aide:followup", "aide:curate", "aide:organize"] as const)
    await assert.rejects(write(origin, create), /read-only/);
  const summary = await write("aide:summary", create);
  for (const origin of ["channel", "chief", "source", "aide:followup", "aide:curate", "aide:organize"] as const)
    await assert.rejects(write(origin, { noteId: summary.noteId, version: summary.version, text: "temporary claim" }), /read-only/);
  assert.equal((await readNote(f.resources, summary.noteId)).text, create.text);
  const edited = await write("aide:summary", { noteId: summary.noteId, version: summary.version, text: "" });
  assert.equal(edited.uid, summary.uid);
  assert.equal((await readNote(f.resources, summary.noteId)).text, "");
  const person = await f.aide.persons.observe({ provider: "test", scope: "knowledge", id: "operator" });
  const personal = { summaryOf: resourceRef(person), text: "Verified role" };
  await assert.rejects(write("aide:organize", personal), /read-only/);
  const profile = await write("aide:summary", personal);
  await assert.rejects(write("aide:organize", { noteId: profile.noteId, version: profile.version, text: "New role" }), /read-only/);
});

test("organize splits a mixed Note across Topics through its admitted tools", async t => {
  const f = await setup(t);
  const initial = await f.aide.topics.ensure("metrics");
  const child = await f.resources.replace(initial, { ...initial.spec, parentRef: resourceRef(f.root) }, initial.status);
  const incident = "The oncall review is pending.", method = "Measure acknowledgement time from the first page.";
  const source = await f.note({ nature: "semantic", text: incident + " " + method }, "mixed");
  const tools = [...chiefTools(emptyConnectors), ...chiefNoteTools(f.note), ...topicTools(f.aide.personal.store, f.read, log, () => "aide:organize")];
  const available = toolsForInput(tools, "aide:organize");
  for (const name of ["upsert_note", "prune_note", "retire_note", "split_note", "move_note", "move_input", "move_work", "create_topic", "move_topic"])
    assert.ok(available.includes(name), name);
  const curate = toolsForInput(tools, "aide:curate");
  assert.ok(!curate.includes("move_topic"));
  assert.ok(curate.includes("upsert_note") && available.includes("upsert_note"));
  const execute = (name: string, args: Record<string, unknown>) =>
    tools.find(tool => tool.name === name && available.includes(name))!.execute(name, args, undefined, undefined, {} as never);
  for (const origin of ["chief", "source", "channel", "aide:followup"] as const)
    assert.ok(!toolsForInput(tools, origin).includes("split_note"));
  const args = { ...source, text: incident, reason: "File the method under metrics", parts: [
    { subject: resourceRef(child), text: method, nature: "procedural" }] };
  const outside = await f.aide.topics.ensure("outside-split");
  await assert.rejects(execute("split_note", { ...args, parts: [{ text: method }] }), /nature/);
  assert.equal((await f.get(source.noteId)).spec.text, incident + " " + method);
  await assert.rejects(execute("split_note", { ...args, parts: [...args.parts, { text: "Another part", nature: "semantic", subject: resourceRef(outside) }] }), /outside/);
  assert.equal((await f.get(source.noteId)).spec.text, incident + " " + method);
  assert.equal((await listNotes(f.resources, { subject: child.metadata.uid })).items.length, 0);
  const scoped = await f.note({ nature: "semantic", text: incident + " " + method, visibility: "topic" }, "scoped");
  await assert.rejects(execute("split_note", { ...args, ...scoped }), /disclosure audience/);
  assert.equal((await f.get(scoped.noteId)).spec.text, incident + " " + method);
  await Promise.all([execute("split_note", args), execute("split_note", args)]);
  await execute("split_note", args);
  const destination = (await listNotes(f.resources, { subject: child.metadata.uid })).items;
  assert.equal(destination.length, 1);
  assert.equal((await readNote(f.resources, destination[0]!.id)).text, method);
  assert.equal(destination[0]!.nature, "procedural");
  const remaining = await readNote(f.resources, source.noteId);
  assert.equal(remaining.text, incident);
  assert.equal(remaining.subject.uid, f.root.metadata.uid);
});

test("splitting and retiring a Summary preserve role, historical citations and the replacement identity", async t => {
  const f = await setup(t);
  const create = (text: string) => upsertTopicNote(f.resources, f.read(), "live", { summaryOf: resourceRef(f.read()), text }, "summary", 4000, "aide:summary");
  const run = (name: string, args: Record<string, unknown>) =>
    topicTools(f.aide.personal.store, f.read, log, () => "aide:summary").find(t => t.name === name)!.execute("call", args, undefined, undefined, {} as never);
  const original = await create("Long-lived scope. A temporary responsibility.");
  await run("split_note", { noteId: original.noteId, version: original.version, text: "Long-lived scope.", reason: "Track the temporary assignment separately",
    parts: [{ text: "A temporary responsibility.", nature: "semantic" }] });
  const active = await readNote(f.resources, original.noteId);
  assert.equal(active.uid, original.uid);
  assert.equal(f.read().status.summaryRevision, active.version);
  const list = async (isSummary: boolean) => (await listNotes(f.resources, { subject: f.root.metadata.uid, isSummary })).items.map(n => n.id);
  assert.deepEqual(await list(true), [active.id]);
  assert.equal((await list(false)).length, 1);
  const args = { noteId: active.id, version: active.version, reason: "Scope was superseded" };
  await assert.rejects(run("move_note", { ...args, subject: resourceRef(f.read()) }), /stays with its owner/);
  await run("retire_note", args);
  assert.deepEqual(await list(true), []);
  assert.equal(f.read().status.summaryRevision, "");
  const historical = await readNote(f.resources, active.uid);
  assert.equal(historical.text, active.text);
  assert.equal(historical.version, active.version);
  assert.ok(historical.retired);
  const replacement = await create("Updated scope");
  assert.notEqual(replacement.noteId, active.id);
  assert.notEqual(replacement.uid, active.uid);
  await run("retire_note", args);
  assert.deepEqual(await list(true), [replacement.noteId]);
  assert.equal(f.read().status.summaryRevision, replacement.version);
});

test("move_note preserves matter identity and age, rejects stale versions and cross-root moves", async t => {
  const f = await setup(t);
  const child = await createWithSummary<TopicSpec, TopicStatus>(f.resources, TOPIC_TYPE, { name: "child", spec: { id: "child", parentRef: resourceRef(f.root) }, status: { summary: "", receipts: [] } });
  const outsider = await f.aide.topics.ensure("outside");
  const initial = await f.note({ nature: "semantic", text: "One continuing matter" }, "start"), before = await readNote(f.resources, initial.noteId);
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
  const initial = await f.note({ nature: "semantic", text: "A continuing matter" }, "start");
  const moved = await moveNote(f.resources, f.read(), { ...initial, subject: resourceRef(routine), reason: "Delegated" });
  const client: ResourceClient = { ...f.resources, async replace(resource, spec, status) {
    await f.resources.replace(child, { id: "child", parentRef: fixtureGateRef(f.aide.topics.resources) }, child.status);
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
  const count = f.aide.topics.list().length + 1;
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
  await f.note({ nature: "semantic", text: "A new unresolved matter" }, "new-evidence");
  assert.notEqual(reclamationVersion(f.read(), f.aide.topics.resources), prior);
  await assert.rejects(call(prior), /understanding changed/);
});

test("full Topic capacity preserves root knowledge until a current explicit release", async t => {
  const f = await setup(t);
  await patchSummary(f.resources, f.read(), { summary: "Lasting knowledge", execution: null });
  const count = f.aide.topics.list().length + 1;
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
  const input = await createMaintenanceInput({ ...f.context, resources }, f.read(), new Date().toISOString(), agenda, "aide:curate", "note_pressure");
  assert.equal(input.status.assess!.topic!.uid, f.root.metadata.uid);
  assert.equal(f.read().status.lastError, "preserved");
  assert.ok(f.read().status.reviewCheckedAt);
});

for (const race of ["parent", "disabled", "schedule-failure"] as const)
test(`review request rolls back on ${race} at commit`, async t => {
  const f = await setup(t);
  await f.resources.patchStatus(f.read(), { execution: null });
  const parent = await f.aide.topics.ensure("new-root");
  const agenda = await maintenanceAgenda(f.resources, []);
  const resources: ResourceClient = { ...f.resources, async commit(writes) {
    if (race === "parent") await f.resources.replace(f.read(), { ...f.read().spec, parentRef: resourceRef(parent) }, f.read().status);
    if (race === "disabled") await f.resources.replace(f.read(), { ...f.read().spec, review: { enabled: false } }, f.read().status);
    return f.resources.commit(race === "schedule-failure" ? [...writes, { operation: "patchStatus", resource: f.read(), patch: { unknown: true } }] : writes);
  } };
  await assert.rejects(createMaintenanceInput({ ...f.context, resources }, f.read(), new Date().toISOString(), agenda, "aide:curate"), race === "schedule-failure" ? /unknown|Unrecognized/ : /eligible root/);
  assert.equal(f.aide.topics.inputStore.list().length, 0);
  assert.equal(f.read().status.reviewCheckedAt ?? null, null);
  assert.equal(f.read().status.maintenanceChecks, undefined);
});

for (const sameDue of [true, false])
test(`racing review requests reuse one pending Input (same due: ${sameDue})`, async t => {
  const f = await setup(t);
  await f.resources.patchStatus(f.read(), { execution: null });
  const agenda = await maintenanceAgenda(f.resources, []), due = new Date().toISOString();
  const [a, b] = await Promise.all([
    createMaintenanceInput(f.context, f.read(), due, agenda, "aide:curate", "note_pressure"),
    createMaintenanceInput(f.context, f.read(), sameDue ? due : "2000-01-01T00:00:00.000Z", agenda, "aide:curate", "note_pressure"),
  ]);
  assert.equal(a.metadata.uid, b.metadata.uid);
  assert.equal(f.aide.topics.inputStore.list().length, 1);
  assert.ok(f.read().status.reviewCheckedAt);
});

/** @case Recent projection never decodes retained history outside its index page. */
test("recent Note projection reads at most 40 objects and no full list", async t => {
  const f = await setup(t);
  for (let i = 0; i < 45; i++) await f.note({ nature: "semantic", text: `matter ${i}` }, String(i));
  const storage = f.aide.topics.resources.storage, read = storage.read.bind(storage);
  let reads = 0;
  storage.read = (...args) => { reads++; return read(...args); };
  try {
    const recent = notes(f.aide.topics.resources, f.root.metadata.uid, "subject");
    assert.equal(recent.length, 40); assert.equal(reads, 40);
  } finally { storage.read = read; }
});

test("Ordinary and summary Notes retain knowledge nature and soft budgets", async t => {
  const f = await setup(t);
  const { upsertNote } = await import("../plugins/personal/note/service.ts");
  const { upsertTopicNote } = await import("../plugins/personal/topic/state.ts");
  const { contentVersion } = await import("../plugins/personal/context-write.ts");
  const created = await f.note({ text: "知".repeat(600), nature: "procedural", maxChars: 256 }, "budget");
  const note = await readNote(f.resources, created.noteId);
  assert.equal(note.text.length, 600); assert.equal(note.nature, "procedural"); assert.equal(note.maxChars, 256);
  const updated = await upsertNote(f.resources, f.read(), { ...created, nature: "semantic" }, "classify");
  assert.equal(updated.overBudget, true); assert.equal(updated.chars, 600);
  const latest = await readNote(f.resources, created.noteId);
  assert.equal(latest.text, note.text); assert.equal(latest.maxChars, 256);
  await upsertTopicNote(f.resources, f.read(), "live", { summaryOf: resourceRef(f.read()), text: "长".repeat(600), nature: "semantic", maxChars: 256, version: contentVersion(f.read()) }, "summary", 256, "aide:summary");
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
  const destination = await f.note({ nature: "semantic", text: "Verified long-term fact." }, "destination");
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
  await assert.rejects(retireNote(f.resources, f.read(), { ...summaryRef, reason: "discard" }), /read-only/);
  const summaryPruned = await pruneNote(f.resources, f.read(), { ...summaryRef, text: "Stable summary", reason: "Remove duplication" }, "prune-summary");
  assert.equal(f.read().status.summaryRevision, summaryPruned.version);
  const outsider = await f.aide.topics.ensure("outside-retire");
  const other = await f.resources.patchStatus(outsider, { execution: { id: "outside", startedAt: new Date().toISOString() } });
  await assert.rejects(retireNote(f.resources, other, { ...destination, reason: "outside" }), /outside/);
});

test("Note pressure counts direct active Notes and includes oversized summaries", async t => {
  const f = await setup(t);
  const { refreshNotePressure, dueNotePressure } = await import("../plugins/personal/note/pressure.ts");
  const { retireNote } = await import("../plugins/personal/note/service.ts");
  const { writeSummary } = await import("../plugins/personal/note/summary.ts");
  await f.resources.replace(f.read(), { ...f.read().spec, maxNotes: 1 }, f.read().status);
  await f.note({ nature: "semantic", text: "first" }, "one");
  const second = await f.note({ nature: "semantic", text: "second" }, "two");
  const child = await createWithSummary<TopicSpec, TopicStatus>(f.resources, TOPIC_TYPE, { name: "pressure-child", spec: { id: "pressure-child", parentRef: resourceRef(f.root) }, status: {} });
  await f.note({ nature: "semantic", subject: resourceRef(child), text: "child" }, "child-note");
  await refreshNotePressure(f.context, f.read());
  let agenda = await dueNotePressure(f.resources, f.read());
  assert.equal(agenda.length, 1); assert.equal(agenda[0]!.pressure.count, 2);
  await completePressure(f, agenda, "live");
  assert.equal((await dueNotePressure(f.resources, f.read())).length, 0, "unchanged no-progress work must not loop");
  await retireNote(f.resources, f.read(), { ...second, reason: "redundant" });
  await refreshNotePressure(f.context, f.read());
  assert.equal(f.read().status.notePressure, undefined);
  await writeSummary(f.resources, f.read(), { text: "s".repeat(300), maxChars: 256 });
  await refreshNotePressure(f.context, f.read());
  agenda = await dueNotePressure(f.resources, f.read());
  assert.equal(agenda[0]!.pressure.count, 1); assert.equal(agenda[0]!.pressure.oversized.length, 1);
  await completePressure(f, agenda);
  assert.equal((await dueNotePressure(f.resources, f.read())).length, 0, "failed or interrupted rounds respect retry delay");
  assert.equal((await dueNotePressure(f.resources, f.read(), Date.now() + 61_000)).length, 1);
});

test("reducing an older Note outside the count sample continues consolidation without scanning history", async t => {
  const f = await setup(t);
  const { refreshNotePressure, dueNotePressure } = await import("../plugins/personal/note/pressure.ts");
  const { retireNote } = await import("../plugins/personal/note/service.ts");
  await f.resources.replace(f.read(), { ...f.read().spec, maxNotes: 1 }, f.read().status);
  const references = [];
  for (let i = 0; i < 4; i++) references.push(await f.note({ nature: "semantic", text: `matter ${i}` }, `note-${i}`));
  await refreshNotePressure(f.context, f.read());
  const agenda = await dueNotePressure(f.resources, f.read());
  assert.equal(agenda[0]!.pressure.count, 2); assert.equal(agenda[0]!.pressure.truncated, true);
  const outside = references.find(n => !agenda[0]!.pressure.notes.some(candidate => candidate.noteId === n.noteId))!;
  await retireNote(f.resources, f.read(), { ...outside, reason: "no independent value" });
  await refreshNotePressure(f.context, f.read());
  assert.equal(f.read().status.notePressure!.version, agenda[0]!.pressure.version, "bounded sample stayed unchanged");
  await completePressure(f, agenda, "live");
  assert.equal((await dueNotePressure(f.resources, f.read(), Date.now() + 61_000)).length, 1, "real reduction schedules another bounded pass");
  await completePressure(f, agenda, "no-reduction-execution");
  assert.equal((await dueNotePressure(f.resources, f.read(), Date.now() + 61_000)).length, 0, "unchanged pressure extends the retry delay");
});


test("stored per-Note review metadata is discarded without changing content or age", async t => {
  const f = await setup(t), n = await f.note({ nature: "semantic", text: "Existing knowledge" }, "legacy");
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
  await reconcileNote(f.context, before);
  assert.deepEqual(await f.get(n.noteId), before);
});

/** Exercise the production creation/completion transactions, including root pressure updates. */
async function completePressure(f: Awaited<ReturnType<typeof setup>>, pressure: import("../plugins/personal/note/pressure.ts").NotePressureTopic[], executionId?: string) {
  if (executionId) await f.resources.patchStatus(f.read(), { execution: { id: executionId, startedAt: new Date().toISOString() } });
  const review = await createMaintenanceInput(f.context, f.read(), new Date().toISOString(),
    await maintenanceAgenda(f.resources, []), "aide:curate", "note_pressure", { cooldownSeconds: 60, instructions: "Review pressure",
      plan: { weaveRevision: 0, notePressure: pressure } });
  if (executionId) await deliverInput(f.resources, f.read(), executionId, review.metadata.name);
}

test("Note renaming preserves pressure identity and backoff while text changes reset it", async t => {
  const f = await setup(t);
  const { refreshNotePressure, dueNotePressure } = await import("../plugins/personal/note/pressure.ts");
  await f.resources.replace(f.read(), { ...f.read().spec, maxNotes: 1 }, f.read().status);
  const first = await f.note({ nature: "semantic", name: "before", text: "same content" }, "one");
  await f.note({ nature: "semantic", text: "another matter" }, "two");
  await refreshNotePressure(f.context, f.read());
  const pressure = f.read().status.notePressure!;
  await completePressure(f, await dueNotePressure(f.resources, f.read()), "live");
  const renamed = await f.note({ ...first, name: "after", text: "same content" }, "rename");
  await refreshNotePressure(f.context, f.read());
  assert.equal(f.read().status.notePressure?.version, pressure.version);
  assert.equal(f.read().status.notePressure?.attempts, 1);
  assert.equal((await dueNotePressure(f.resources, f.read())).length, 0);
  await f.note({ ...renamed, text: "new content" }, "change");
  await refreshNotePressure(f.context, f.read());
  assert.notEqual(f.read().status.notePressure?.version, pressure.version);
  assert.equal(f.read().status.notePressure?.attempts, 0);
  assert.equal((await dueNotePressure(f.resources, f.read())).length, 1);
});

test("Secretary separates curation from one-shot followup and fences stale questions on closure", async t => {
  const { prepareNoteMaintenance } = await import("./maintenance-fixture.ts");
  const { topicPolicy } = await import("../plugins/personal/topic/config.ts");
  const f = await setup(t);
  const policy = topicPolicy();
  const ordinary = await f.note({ nature: "semantic", text: "A verified observation" }, "observed");
  const original = await f.get(ordinary.noteId);
  assert.ok((await prepareNoteMaintenance(f.context, original, policy))!.requeueAfterMs > 0);
  await prepareNoteMaintenance(f.context, original, policy, Date.now() + policy.curation.maxWaitSeconds * 1000);
  const curate = f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:curate");
  assert.equal(curate.length, 1);
  assert.match(curate[0]!.spec.text, new RegExp(ordinary.noteId));

  await assert.rejects(f.note({ text: "A completed observation", nature: "episodic" }, "old-nature"));
  await assert.rejects(f.note({ nature: "semantic", text: "A note cannot schedule", followup: { checkAt: new Date().toISOString() } }, "not-a-plan"));
});

test("Chief declares all responsibilities through Work tools and keeps Ongoing out of delegation", async t => {
  const f = await setup(t);
  const { workTools } = await import("../plugins/personal/chief/agent/work-tools.ts");
  const tools = [...workTools(f.aide.work("knowledge")), ...topicTools(f.aide.personal.store, f.read, log)];
  const call = async (name: string, args: unknown, key = name) => {
    const value = await tools.find(tool => tool.name === name)!.execute(key, args, undefined, undefined, {} as never);
    return JSON.parse((value.content[0] as { text: string }).text);
  };
  const initialInput = await f.aide.work("knowledge").createInput("Verify approval");
  const input = await f.aide.work("knowledge").createInput("Materials submitted");
  const args = { kind: "ongoing", title: "Approval", inputId: initialInput.inputId, question: "Was it accepted?" };
  const matter = await call("upsert_work", args);
  assert.equal((await call("upsert_work", args)).id, matter.id);
  assert.equal(matter.kind, "ongoing");
  assert.equal((await call("list_work", {})).some((w: { id: string }) => w.id === matter.id), true);
  assert.equal((await call("read_work", { id: matter.id })).version, matter.version);
  assert.equal(matter.initialInputId, initialInput.inputId);
  const sourced = await call("upsert_work", { kind: "ongoing", title: "Inspect supporting evidence", sourceId: initialInput.inputId });
  assert.equal(sourced.initialInputId, initialInput.inputId);
  await call("upsert_work", { kind: "ongoing", workId: sourced.id, version: sourced.version, outcome: "Evidence reviewed" });
  assert.ok(f.aide.topics.inputStore.get(initialInput.inputId)?.status.handle?.[matter.uid]?.completedAt);
  const append = () => call("append_input", { workId: matter.id, input: { id: input.inputId } });
  await Promise.all([append(), append()]);
  assert.equal(f.aide.topics.inputStore.get(input.inputId)?.status.handle?.[matter.uid]?.resource.uid, matter.uid);
  await prepareOngoingCheck(f.context, await readOngoing(f.resources, f.read(), matter.id), topicPolicy());
  const reminder = f.aide.topics.inputStore.list().find(i => i.spec.observation?.trigger === "work_input");
  assert.deepEqual(reminder?.spec.observation?.inputIds, [input.inputId]);
  assert.ok(f.aide.topics.inputStore.get(input.inputId)?.status.handle?.[matter.uid]?.completedAt);
  assert.equal((await call("read_work", { id: matter.id })).checkAt, matter.checkAt);
  const followupTools = toolsForInput(tools, "aide:followup");
  assert.ok(followupTools.includes("upsert_work"));
  assert.ok(!followupTools.includes("append_input"));
  await call("upsert_work", { kind: "ongoing", workId: matter.id, version: (await call("read_work", { id: matter.id })).version, outcome: "Confirmed receipt of approval" });
  assert.deepEqual(await call("list_work", { kind: "ongoing" }), []);
  assert.equal((await call("list_work", { kind: "ongoing", includeClosed: true }))[0].status, "closed");
});

test("Ongoing checks have an independent identity, one durable request and one private question", async t => {
  const f = await setup(t);
  const args = { title: "Metrics sign-off", question: "Are the metrics final?" };
  const initial = await upsertOngoing(f.resources, f.read(), args, "metrics");
  const read = () => readOngoing(f.resources, f.read(), initial.id);
  const matter = await read();
  const due = Date.parse(initial.checkAt!);
  assert.equal(due - Date.parse(matter.status.updatedAt), 3_600_000);
  assert.equal((await upsertOngoing(f.resources, f.read(), args, "metrics")).uid, initial.uid);
  const policy = topicPolicy();
  assert.deepEqual(await prepareOngoingCheck(f.context, matter, policy, due - 1), { requeueAfterMs: 1 });
  await Promise.all([prepareOngoingCheck(f.context, matter, policy, due), prepareOngoingCheck(f.context, matter, policy, due)]);
  await prepareOngoingCheck(f.context, await read(), policy, due);
  const requests = f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:followup");
  assert.equal(requests.length, 1);
  const request = requests[0]!;
  assert.equal(request.spec.observation?.ongoingUid, initial.uid);
  assert.equal(request.spec.observation?.trigger, "question_due");
  await f.resources.patchStatus(request, { assess: { ...request.status.assess, executionId: "live", startedAt: new Date().toISOString() } });
  const ask = () => f.aide.topics.say("knowledge", undefined, args.question, "live",
    { workId: initial.id, purpose: "question", to: { me: true }, inputIds: [request.metadata.name] });
  await fixtureMe(f.aide);
  await deliverInput(f.resources, f.read(), "live", request.metadata.name);
  await upsertOngoing(f.resources, f.read(), { ongoingId: initial.id, version: (await read()).metadata.resourceVersion,
    checkAt: new Date(due + 86_400_000).toISOString() }, "reschedule");
  const first = await ask();
  assert.deepEqual(await ask(), first);
  assert.equal(f.aide.topics.outputStore.get(first.outputId)?.spec.target.uid, f.aide.defaultAddress().uid);
  assert.equal(f.aide.topics.outputStore.get(first.outputId)?.spec.work?.uid, initial.uid);
  assert.equal(f.aide.topics.outputStore.get(first.outputId)?.spec.purpose, "question");
  assert.equal((await read()).status.closure, undefined);
  const closed = await upsertOngoing(f.resources, f.read(), { ongoingId: initial.id,
    version: (await read()).metadata.resourceVersion, outcome: "Me confirmed final sign-off" }, "close");
  await assert.rejects(ask(), /open Ongoing/);
  assert.equal(closed.closure?.outcome, "Me confirmed final sign-off");
  assert.equal(closed.checkAt, undefined);
  assert.equal(await prepareOngoingCheck(f.context, await read(), policy, due), undefined);
});

test("Chief can ask about the current question it revised in the same followup", async t => {
  const f = await setup(t);
  await fixtureMe(f.aide);
  const matter = await upsertOngoing(f.resources, f.read(), {
    title: "Sign-off", question: "Is sign-off complete?", checkAt: new Date(0).toISOString(),
  }, "signoff");
  const read = () => readOngoing(f.resources, f.read(), matter.id);
  await prepareOngoingCheck(f.context, await read(), topicPolicy());
  const request = f.aide.topics.inputStore.get((await read()).status.followupInputId!)!;
  await deliverInput(f.resources, f.read(), "live", request.metadata.name);
  const question = "When is sign-off scheduled?";
  await upsertOngoing(f.resources, f.read(), { ongoingId: matter.id, version: (await read()).metadata.resourceVersion, question }, "revise");
  const ask = () => f.aide.topics.say("knowledge", undefined, question, "live", {
    workId: matter.id, purpose: "question", to: { me: true }, inputIds: [request.metadata.name] });
  const first = await ask();
  assert.deepEqual(await ask(), first);
  assert.equal(f.aide.topics.outputStore.get(first.outputId)?.spec.work?.uid, matter.uid);
  assert.equal(f.aide.outputs().length, 1);
});

test("new material and a due appointment share one followup and one question opportunity", async t => {
  const f = await setup(t), work = f.aide.work("knowledge");
  const matter = await work.create({ kind: "ongoing", title: "Verify approval", checkAt: "2024-01-01T00:00:00.000Z" });
  const { inputId } = await work.appendInput(matter.id, { text: "Approval is still pending." });
  const read = () => readOngoing(f.resources, f.read(), matter.id);
  await prepareOngoingCheck(f.context, await read(), topicPolicy());
  const request = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:followup")!;
  assert.deepEqual(request.spec.observation?.inputIds, [inputId]);
  assert.equal((await read()).status.followupInputId, request.metadata.name);
  assert.equal(await prepareOngoingCheck(f.context, await read(), topicPolicy()), undefined);
});

test("business Inputs and delivered Batch members can ask about an open Work before its timer", async t => {
  const { prepareBatch } = await import("../plugins/personal/batch/prepare.ts");
  const { BATCH_TYPE } = await import("../plugins/personal/batch/model.ts");
  const { assignInput } = await import("../plugins/personal/input/assignment.ts");
  const f = await setup(t);
  await fixtureMe(f.aide);
  const matter = await upsertOngoing(f.resources, f.read(), { title: "Approval", question: "Is approval final?" }, "approval");
  for (const batched of [false, true]) {
    const input = await f.aide.topics.submit(`evidence-${batched}`, { origin: "source", originId: "fixture", text: "The draft was submitted",
      attention: batched ? InputAttention.Deferred : InputAttention.Normal });
    await routeTo(f.resources, f.read().metadata, input);
    const routed = f.aide.topics.inputStore.get(input.metadata.name)!;
    const ask = () => f.aide.topics.say("knowledge", undefined, "Is approval final?", "live", {
      workId: matter.id, purpose: "question", to: { me: true }, inputIds: [input.metadata.name] });
    await assert.rejects(ask(), /admitted/);
    if (batched) {
      const batch = await prepareBatch(f.context, f.read(), [routed], new Date().toISOString());
      const ready = await f.resources.get({ ...BATCH_TYPE, namespace: "v1", name: batch!.metadata.name });
      await f.resources.patchStatus(ready!, { phase: "running", assess: { executionId: "live", startedAt: new Date().toISOString() } });
    } else {
      await assignInput(f.context, routed);
      await deliverInput(f.resources, f.read(), "live", input.metadata.name);
    }
    const accepted = await ask();
    assert.deepEqual(await ask(), accepted);
    assert.equal(f.aide.topics.outputStore.get(accepted.outputId)?.spec.inputUids?.[input.metadata.name], input.metadata.uid);
  }
  const view = await f.aide.work("knowledge").readItem(matter.id);
  assert.ok(view.kind === "ongoing");
  assert.deepEqual(view.outputs.map(o => o.phase), ["pending", "pending"]);
});

test("startup converts existing Ongoing checks without rearming a consumed appointment", async t => {
  const { upgradeOngoingChecks } = await import("../plugins/personal/ongoing/upgrade.ts");
  const { digest } = await import("../plugins/personal/identity.ts");
  const f = await setup(t);
  const matter = await upsertOngoing(f.resources, f.read(), { title: "Await response" }, "legacy");
  const storage = f.aide.topics.inputStore.storage;
  const priorId = `followup-${digest([matter.uid, 2])}`;
  storage.db.prepare(`UPDATE resources SET data = json_set(json_remove(data,'$.object.status.nextCheckAt'),
    '$.object.status.planRevision',2,'$.object.status.followupInputId',?,'$.object.status.askedFollowupId',?,'$.object.spec.checkAt',?) WHERE uid=?`)
    .run(priorId, priorId, matter.checkAt!, matter.uid);
  assert.equal(upgradeOngoingChecks(storage), 1);
  assert.equal(upgradeOngoingChecks(storage), 0);
  const saved = await readOngoing(f.resources, f.read(), matter.id);
  assert.equal(saved.status.followupInputId, priorId);
  assert.equal(saved.status.nextCheckAt, matter.checkAt);
  await prepareOngoingCheck(f.context, saved, topicPolicy(), Date.parse(matter.checkAt!) + 1);
  const renewed = await readOngoing(f.resources, f.read(), matter.id);
  assert.equal(renewed.status.nextCheckAt, new Date(Date.parse(matter.checkAt!) + 3_600_000).toISOString());
  assert.equal(renewed.status.followupInputId, undefined);
  assert.ok(!f.aide.topics.inputStore.list().some(i => i.spec.origin === "aide:followup"));
});

test("delivered time-only checks schedule the next hour once and stay silent", async t => {
  const f = await setup(t);
  const matter = await upsertOngoing(f.resources, f.read(), { title: "Awaiting approval" }, "approval");
  const read = () => readOngoing(f.resources, f.read(), matter.id);
  const due = Date.parse(matter.checkAt!);
  await prepareOngoingCheck(f.context, await read(), topicPolicy(), due);
  const request = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:followup")!;
  assert.equal(request.spec.observation?.trigger, "ongoing_check_due");
  await f.resources.patchStatus(request, { assess: { ...request.status.assess, executionId: "live", startedAt: new Date().toISOString() } });
  await deliverInput(f.resources, f.read(), "live", request.metadata.name);
  assert.equal((await read()).status.closure, undefined);
  assert.equal(f.aide.outputs().length, 0);
  const delivered = f.aide.topics.inputStore.get(request.metadata.name)!.status.assess!.completedAt!;
  const next = Date.parse(delivered) + 3_600_000;
  assert.equal((await read()).status.nextCheckAt, new Date(next).toISOString());
  assert.equal((await read()).status.followupInputId, undefined);
  await deliverInput(f.resources, f.read(), "live", request.metadata.name);
  assert.equal((await read()).status.nextCheckAt, new Date(next).toISOString());
  assert.equal((await prepareOngoingCheck(f.context, await read(), topicPolicy(), next - 1))?.requeueAfterMs, 1);
  const second = await prepareOngoingCheck(f.context, await read(), topicPolicy(), next);
  assert.notEqual(second?.input?.metadata.name, request.metadata.name);
  assert.ok(second?.input);
});

test("curating or retiring evidence leaves its Ongoing open; updated plans fence stale writes", async t => {
  const f = await setup(t);
  const checkAt = new Date(Date.now() + 72 * 3_600_000).toISOString();
  const question = "Has the release been approved?";
  const matter = await upsertOngoing(f.resources, f.read(), { title: "Release approval", question, checkAt }, "release");
  const evidence = await f.note({ nature: "semantic", text: "Initial release evidence" }, "evidence");
  const { retireNote } = await import("../plugins/personal/note/service.ts");
  await retireNote(f.resources, f.read(), { ...evidence, reason: "Duplicate evidence" }, "aide:curate");
  const read = () => readOngoing(f.resources, f.read(), matter.id);
  assert.equal((await read()).metadata.resourceVersion, matter.version);
  const paused = await upsertOngoing(f.resources, f.read(), { ongoingId: matter.id, version: matter.version, checkAt: null }, "wait");
  assert.equal(paused.checkAt, undefined);
  assert.equal(paused.question, question);
  assert.equal(await prepareOngoingCheck(f.context, await read(), topicPolicy()), undefined);
  await assert.rejects(upsertOngoing(f.resources, f.read(), { ongoingId: matter.id, version: matter.version, outcome: "stale" }, "late"), /version/);
  const other = await f.aide.topics.ensure("other-domain");
  await assert.rejects(readOngoing(f.resources, other, matter.id), /scope/);
  const rescheduled = await upsertOngoing(f.resources, f.read(), { ongoingId: matter.id, version: paused.version, checkAt }, "resume");
  assert.equal(rescheduled.checkAt, checkAt);
  assert.equal((await read()).status.nextCheckAt, checkAt);
});

test("retrospective decisions reuse sourced Work across rounds and retain the Note's independent evidence", async t => {
  const f = await setup(t);
  const { workTools } = await import("../plugins/personal/chief/agent/work-tools.ts");
  const tools = workTools(f.aide.work("knowledge"));
  assert.ok(toolsForInput(tools, "aide:curate").includes("append_input"));
  const upsert = tools.find(tool => tool.name === "upsert_work")!;
  const note = await f.note({ nature: "semantic", text: "The handover happened. An audit and recurring checks are authorized; await acknowledgment." }, "handover");
  const source = await f.get(note.noteId);
  const create = async (args: object, callId: string) => {
    const response = await upsert.execute(callId, { ...args, sourceId: note.noteId }, undefined, undefined, {} as never);
    return JSON.parse((response.content[0] as { text: string }).text);
  };
  const task = { kind: "task", title: "Audit handover", instruction: "Check the signed handover", trigger: null };
  const routine = { kind: "routine", title: "Review each handover", instruction: "Check the handover on receipt",
    trigger: { cron: null, timezone: "UTC", event: "handover" } };
  const ongoing = { kind: "ongoing", title: "Await acknowledgment" };
  for (const args of [task, routine, ongoing]) {
    const created = await create(args, "first");
    assert.equal(created.sourceUid, source.metadata.uid);
    assert.equal((await create(args, "later")).id, created.id);
    if (args.kind === "task") {
      const decision = f.aide.topics.inputStore.list().find(i => i.status.handle?.[created.uid]);
      assert.equal(decision?.spec.origin, "chief");
      assert.equal(decision?.spec.text, task.instruction);
    }
  }
  assert.equal(f.aide.work("knowledge").listItems().length, 3);
  assert.equal((await f.get(note.noteId)).spec.text, source.spec.text);
  const secondGoal = await create({ ...task, title: "Deliver audit report" }, "second-goal");
  assert.notEqual(secondGoal.id, (await create(task, "repeat")).id);
});

test("two stale-only assessments defer that material behind other pending drafts", async t => {
  const { pendingCuration } = await import("../plugins/personal/note/model.ts");
  const { prepareNoteMaintenance } = await import("./maintenance-fixture.ts");
  const f = await setup(t);
  const policy = topicPolicy({ curation: { count: 1 } });
  const draft = await f.note({ nature: "semantic", text: "Waiting for the receipt" }, "first");
  await prepareNoteMaintenance(f.context, await f.get(draft.noteId), policy);
  const req = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:curate")!;
  await f.resources.patchStatus(req, { assess: { ...req.status.assess, executionId: "live" } });
  await f.note({ ...draft, text: "Receipt arrived" }, "changed");
  const other = await f.note({ nature: "semantic", text: "Another handover" }, "another");
  const finish = () => confirmCuratedNotes(f.resources, f.read(), "live", { inputId: req.metadata.name, curatedNotes: [draft] });
  await deliverInput(f.resources, f.read(), "live", req.metadata.name);
  const deferred = await finish();

  assert.deepEqual(deferred.noteResults, [{ noteId: draft.noteId, status: "version_changed" }]);
  assert.deepEqual(await finish(), deferred);
  assert.ok(pendingCuration(await f.get(other.noteId))! <= pendingCuration(await f.get(draft.noteId))!);
  assert.equal((await f.get(draft.noteId)).status.curated, undefined);
});

test("Note dispatch cooldown follows the material across overlapping batches and survives reopening", async t => {
  const { prepareNoteMaintenance } = await import("./maintenance-fixture.ts");
  const f = await setup(t), policy = topicPolicy({ curation: { count: 1 } });
  const a = await f.note({ nature: "semantic", text: "A" }, "a");
  const b = await f.note({ nature: "semantic", text: "B" }, "b");
  const now = Date.now();
  const requests = () => f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:curate");
  await Promise.all([a, b].map(async n => prepareNoteMaintenance(f.context, await f.get(n.noteId), policy, now)));
  assert.equal(requests().length, 1);
  const first = requests()[0]!;
  assert.deepEqual(new Set((first.spec.observation!.notes as typeof a[]).map(n => n.noteId)), new Set([a.noteId, b.noteId]));
  const retryAt = (await f.get(a.noteId)).status.curateAt!;
  assert.equal((await f.get(b.noteId)).status.curateAt, retryAt);
  assert.ok(Date.parse(retryAt) >= now + policy.curation.maxWaitSeconds * 1000);

  const c = await f.note({ nature: "semantic", text: "C" }, "c");
  await prepareNoteMaintenance(f.context, await f.get(c.noteId), policy, now + 1);
  assert.equal((await f.get(c.noteId)).status.curateAt, undefined);
  await deliverInput(f.resources, f.read(), "live", first.metadata.name);
  await prepareNoteMaintenance(f.context, await f.get(c.noteId), policy, now + 2);
  const second = requests().find(i => i.metadata.uid !== first.metadata.uid)!;
  assert.deepEqual(second.spec.observation!.notes, [c]);
  await deliverInput(f.resources, f.read(), "live", second.metadata.name);
  const renamed = await f.note({ ...a, name: "new label" }, "rename");
  assert.equal((await f.get(a.noteId)).status.curateAt, retryAt);
  await f.note({ ...renamed, text: "A changed" }, "edit");
  assert.equal((await f.get(a.noteId)).status.curateAt, undefined);

  const { home } = f;
  await f.aide.close();
  const reopened = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected inference"); } }, home), log);
  try {
    const resources = reopened.runtime.plugins.resourceClient("personal");
    const saved = (await resources.get<NoteSpec, NoteStatus>({ ...NOTE_TYPE, name: b.noteId, namespace: "v1" }))!;
    assert.equal(saved.status.curateAt, retryAt);
    const ctx = { ...f.context, resources };
    assert.equal(await prepareNoteMaintenance(ctx, saved, policy, Date.parse(retryAt) - 1), undefined);
    await prepareNoteMaintenance(ctx, saved, policy, Date.parse(retryAt));
    const retried = await resources.get<NoteSpec, NoteStatus>(resourceRef(saved));
    assert.equal(retried!.status.curateAt, retryAt);
    assert.deepEqual(retried!.status.curationDelivery, saved.status.curationDelivery);
    assert.equal(saved.status.curationDelivery?.inputUid, first.metadata.uid);
  } finally { await reopened.close(); }
});

test("curate batches classified drafts and acknowledges only final versions it actually reviewed", async t => {
  const { prepareNoteMaintenance } = await import("./maintenance-fixture.ts");
  const { topicPolicy } = await import("../plugins/personal/topic/config.ts");
  const { pendingCuration } = await import("../plugins/personal/note/model.ts");
  const f = await setup(t);
  await f.aide.topics.setReviewEnabled(f.root.spec.id, false);
  const policy = topicPolicy({ curation: { count: 2 } });
  const first = await f.note({ nature: "semantic", text: "Me provisionally owns the metrics" }, "handoff");
  const initial = await f.get(first.noteId);
  await prepareNoteMaintenance(f.context, initial, policy);
  const requests = () => f.aide.topics.inputStore.list().filter(i => i.spec.origin === "aide:curate");
  assert.equal(requests().length, 0);
  const child = await createWithSummary<TopicSpec, TopicStatus>(f.resources, TOPIC_TYPE, {
    name: "metrics", spec: { id: "metrics", parentRef: resourceRef(f.root) }, status: { receipts: [] } });
  const other = await f.note({ nature: "semantic", text: "The role changes each quarter", subject: resourceRef(child) }, "policy");
  await prepareNoteMaintenance(f.context, await f.get(other.noteId), policy);
  const [request] = requests();
  assert.equal(request!.spec.observation?.trigger, "notes_changed");
  assert.deepEqual(new Set((request!.spec.observation?.notes as typeof first[]).map(n => n.noteId)), new Set([first.noteId, other.noteId]));
  await f.resources.patchStatus(request!, { assess: { ...request!.status.assess, executionId: "live", startedAt: new Date().toISOString() } });
  const revised = await f.note({ ...first, text: "Metrics ownership transferred to the new lead" }, "curate-edit");
  const destination = await f.note({ nature: "procedural", text: "Confirm the current owner in the oncall schedule" }, "curate-split");
  const concurrent = await f.note({ ...other, text: "Rotation now takes place monthly" }, "business-update");
  await deliverInput(f.resources, f.read(), "live", request!.metadata.name);
  const assess = () => confirmCuratedNotes(f.resources, f.read(), "live", { inputId: request!.metadata.name,
    curatedNotes: [revised, destination, other] });
  const receipt = await assess();
  assert.deepEqual(receipt.noteResults?.map(n => n.status), ["confirmed", "confirmed", "version_changed"]);
  assert.deepEqual((await assess()).noteResults.map(n => n.status), ["already_curated", "already_curated", "version_changed"]);
  assert.equal(pendingCuration(await f.get(first.noteId)), undefined);
  assert.equal(pendingCuration(await f.get(destination.noteId)), undefined);
  assert.ok(pendingCuration(await f.get(concurrent.noteId)));
  assert.equal(await prepareNoteMaintenance(f.context, await f.get(first.noteId), policy), undefined);
  const renamed = await f.note({ ...revised, name: "Metrics handover", maxChars: 500 }, "display");
  assert.equal(pendingCuration(await f.get(renamed.noteId)), undefined);
  const closed = await f.note({ ...renamed, text: "Verified the final assignment" }, "confirmed");
  assert.ok(pendingCuration(await f.get(closed.noteId)));
});

test("an unclassified draft stays pending through edits until its classified version is acknowledged", async t => {
  const { pendingCuration } = await import("../plugins/personal/note/model.ts");
  const { prepareNoteMaintenance } = await import("./maintenance-fixture.ts");
  const { topicPolicy } = await import("../plugins/personal/topic/config.ts");
  const f = await setup(t), policy = topicPolicy();
  const draft = await f.note({ text: "Prepare oncall metrics and document the process" }, "draft");
  assert.equal((await f.get(draft.noteId)).spec.nature, undefined);
  const since = pendingCuration(await f.get(draft.noteId))!;
  const edited = await f.note({ ...draft, text: "Document the oncall metrics process" }, "progress");
  assert.equal(pendingCuration(await f.get(draft.noteId)), since);
  await prepareNoteMaintenance(f.context, await f.get(draft.noteId), policy, Date.parse(since) + policy.curation.maxWaitSeconds * 1000);
  const request = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:curate")!;
  await f.resources.patchStatus(request, { assess: { ...request.status.assess, executionId: "live", startedAt: new Date().toISOString() } });
  await deliverInput(f.resources, f.read(), "live", request.metadata.name);
  const finish = (receipt: typeof draft) => confirmCuratedNotes(f.resources, f.read(), "live",
    { inputId: request.metadata.name, curatedNotes: [receipt] });
  assert.deepEqual((await finish(edited)).noteResults, [{ noteId: edited.noteId, status: "needs_nature" }]);
  assert.ok(f.aide.topics.inputStore.get(request.metadata.name)?.status.assess?.completedAt);
  const classified = await f.note({ ...edited, nature: "procedural" }, "classify");
  await finish(classified);
  assert.equal(pendingCuration(await f.get(draft.noteId)), undefined);
});

test("evidence that a matter is still ongoing settles the old check without asking Me", async t => {
  const { topicPolicy } = await import("../plugins/personal/topic/config.ts");
  const f = await setup(t);
  const matter = await upsertOngoing(f.resources, f.read(), { title: "Awaiting final sign-off",
    question: "Has sign-off happened?", checkAt: new Date(0).toISOString() }, "signoff");
  const read = () => readOngoing(f.resources, f.read(), matter.id);
  await prepareOngoingCheck(f.context, await read(), topicPolicy());
  const request = f.aide.topics.inputStore.list().find(i => i.spec.origin === "aide:followup")!;
  await f.resources.patchStatus(request, { assess: { ...request.status.assess, executionId: "live", startedAt: new Date().toISOString() } });
  const followup = { question: "Did the scheduled sign-off complete?", checkAt: new Date(Date.now() + 86_400_000).toISOString() };
  await upsertOngoing(f.resources, f.read(), { ongoingId: matter.id, version: (await read()).metadata.resourceVersion,
    progress: "Owner confirmed review and scheduled sign-off for tomorrow", ...followup }, "progress");
  await deliverInput(f.resources, f.read(), "live", request.metadata.name);
  const updated = await read();
  assert.equal(updated.status.closure, undefined);
  assert.equal(updated.status.nextCheckAt, followup.checkAt);
  assert.equal(updated.spec.question, followup.question);
  assert.equal(f.aide.outputs().length, 0);
});

test("window expiry preserves pending Notes without forcing a final curation", async t => {
  const { selectChiefIntake } = await import("../plugins/personal/chief/intake.ts");
  const f = await setup(t);
  await f.note({ nature: "semantic", text: "Evidence for a later review" }, "draft");
  const policy = topicPolicy({ curation: { count: 1 } });
  await f.resources.patchStatus(f.read(), { execution: null, lastInputAt: new Date(Date.now() - 1801_000).toISOString() });
  assert.equal((await selectChiefIntake(f.context, f.read(), policy)).intake, undefined);
  await f.resources.patchStatus(f.read(), { lastInputAt: new Date().toISOString() });
  assert.equal((await selectChiefIntake(f.context, f.read(), policy)).intake?.inputs[0]?.spec.origin, "aide:curate");
});
