import { workPhase } from "../plugins/personal/status.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { digest } from "../plugins/personal/chief-model.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "../plugins/personal/topic/model.ts";
import { summarizeTopic, upsertTopicNote } from "../plugins/personal/topic/state.ts";
import { pendingAbsorption, summaryVersion, understandingVersion } from "../plugins/personal/topic/tree.ts";
import { reconcileChief } from "../plugins/personal/topic/reconcile.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { workContextTools } from "../plugins/personal/work-context.ts";
import { workType, type WorkSpec } from "../plugins/personal/resources.ts";
import type { WorkAgentStatus } from "../plugins/personal/work-status.ts";
import { reportWork } from "../plugins/personal/work-report.ts";
import { chiefNoteTools } from "../agents/chief/note-tools.ts";
import { personTools } from "../agents/chief/person-tools.ts";
import { relatedWork } from "../plugins/personal/background.ts";
import { RECENT_COUNT } from "../plugins/personal/context.ts";

const log = pino({ level: "silent" });
async function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-notes-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("Unexpected Work execution"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const root = await aide.topics.ensure("notes");
  await resources.patchStatus(root, { execution: { id: "live", startedAt: new Date().toISOString() }, summary: "Keep the distinction between reported and verified completion." });
  const read = () => aide.topics.resource("notes")!;
  return { aide, resources, root, read };
}

test("one Topic Note follows a matter across progress, retries and conflicts without displacing old rules", async t => {
  const f = await setup(t), initial = f.read();
  const created = await upsertTopicNote(f.resources, initial, "live", { version: initial.metadata.resourceVersion, text: "A started X" }, "start");
  const createdAt = f.read().status.recent[0]!.createdAt;
  const half = await upsertTopicNote(f.resources, f.read(), "live", { version: created.version, noteId: created.noteId, text: "A reports X is 50% complete" }, "half");
  const done = await upsertTopicNote(f.resources, f.read(), "live", { version: half.version, noteId: half.noteId, text: "A reports X complete; not independently verified" }, "done");
  assert.equal(f.read().status.recent.length, 1);
  assert.equal(done.noteId, created.noteId);
  assert.equal(f.read().status.recent[0]!.createdAt, createdAt);
  assert.equal(f.read().status.summary, initial.status.summary);
  const unchanged = await upsertTopicNote(f.resources, f.read(), "live", { version: done.version, noteId: done.noteId, text: "A reports X complete; not independently verified" }, "same-text");
  assert.equal(unchanged.version, done.version, "Identical progress does not refresh the window or create a new version");
  const retry = await upsertTopicNote(f.resources, f.read(), "live", { version: initial.metadata.resourceVersion, text: "A started X" }, "start");
  assert.equal(retry.noteId, created.noteId);
  assert.equal(f.read().status.recent[0]!.text, "A reports X complete; not independently verified", "Creation replay cannot restore earlier progress");
  await assert.rejects(upsertTopicNote(f.resources, f.read(), "live", { version: half.version, noteId: done.noteId, text: "stale progress" }, "stale"), /version conflict/);
  await assert.rejects(upsertTopicNote(f.resources, f.read(), "live", { version: done.version, noteId: "foreign-note", text: "wrong owner" }, "foreign"), /no longer exists/);
  const before = f.read();
  await summarizeTopic(f.resources, before, "live", { version: before.metadata.resourceVersion, summary: "Keep the old distinction; A's reports need independent verification." }, 4000);
  assert.deepEqual(f.read().status.recent, before.status.recent);
  await assert.rejects(upsertTopicNote(f.resources, f.read(), "old-execution", { version: f.read().metadata.resourceVersion, text: "obsolete execution" }, "old"), /no longer active/);
  const outsider = await f.aide.topics.ensure("outside");
  await assert.rejects(upsertTopicNote(f.resources, f.read(), "live", { version: outsider.metadata.resourceVersion, topicUid: outsider.metadata.uid, text: "unrelated" }, "outside"), /outside this root/);
});

test("evicted Note updates fail instead of creating replacement matters; Notes survive storage reopen", async t => {
  const f = await setup(t);
  const first = await upsertTopicNote(f.resources, f.read(), "live", { version: f.read().metadata.resourceVersion, text: "Old matter" }, "old");
  for (let n = 0; n <= RECENT_COUNT; n++) {
    await upsertTopicNote(f.resources, f.read(), "live", { version: f.read().metadata.resourceVersion, text: `Distinct matter ${n}` }, `new-${n}`);
  }
  assert.equal(f.read().status.recent.length, RECENT_COUNT);
  await assert.rejects(upsertTopicNote(f.resources, f.read(), "live", { version: f.read().metadata.resourceVersion, noteId: first.noteId, text: "revive" }, "revive"), /no longer exists/);
  const { PluginResourceStore } = await import("../src/host/plugin/resource/store.ts");
  const reopened = new PluginResourceStore({ home: f.aide.personal.store.resources.storage.home, pluginInstanceId: "personal" });
  assert.deepEqual(reopened.get<TopicSpec, TopicStatus>(TOPIC_TYPE, f.root.metadata.name).status.recent, f.read().status.recent);
});

test("Note-only child changes wait for an active review; child review receipts do not require summary text", async t => {
  const f = await setup(t);
  const child = await f.resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, { name: digest("child"),
    spec: { id: "child", parentRef: resourceRef(f.read()) }, status: { summary: "A durable child rule", recent: [], receipts: [] } });
  await f.resources.patchStatus(f.read(), { absorbed: { [child.metadata.uid]: understandingVersion(child) }, absorbedSummaries: { [child.metadata.uid]: summaryVersion(child) } });
  await upsertTopicNote(f.resources, f.read(), "live", { topicUid: child.metadata.uid, version: child.metadata.resourceVersion, text: "A temporary deployment is 50% complete" }, "child-progress");
  let all = await f.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
  assert.equal(pendingAbsorption(all, f.read()).length, 0);
  assert.equal(pendingAbsorption(all, f.read(), true).length, 1);
  await f.resources.patchStatus(f.read(), { execution: null });
  const context = { resources: f.resources, instance: { config: {} }, logger: { info() {}, warn() {}, error() {} } } as unknown as PluginContext;
  const execution = { verbs: { harness() { throw new Error("Note change must not activate summary maintenance"); } } } as unknown as ReconcileContext;
  await reconcileChief(context, execution, f.read());
  await f.resources.patchStatus(f.read(), { execution: { id: "live", startedAt: new Date().toISOString() } });
  const before = f.read();
  all = await f.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
  const updatedChild = all.find(topic => topic.metadata.uid === child.metadata.uid)!;
  await summarizeTopic(f.resources, before, "live", { version: before.metadata.resourceVersion,
    absorbed: [{ uid: child.metadata.uid, version: understandingVersion(updatedChild) }] }, 4000);
  assert.equal(f.read().status.summary, before.status.summary);
  assert.deepEqual(f.read().status.recent, before.status.recent);
  assert.equal(pendingAbsorption(await f.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE), f.read(), true).length, 0);
  await summarizeTopic(f.resources, f.read(), "live", { version: updatedChild.metadata.resourceVersion, topicUid: child.metadata.uid, summary: "A genuinely changed long-term rule" }, 4000);
  assert.equal(pendingAbsorption(await f.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE), f.read()).length, 1);
});

for (const kind of ["task", "routine"] as const)
test(`${kind} uses host-bound Note and summary tools without acknowledging business completion`, async t => {
  const f = await setup(t);
  const work = await f.aide.work("notes").create({ kind, title: "Investigate", instruction: "Verify evidence",
    trigger: kind === "routine" ? { cron: "* * * * *", timezone: "UTC", event: null } : null });
  const get = () => f.aide.personal.store.resources.get<WorkSpec, WorkAgentStatus>(workType(kind), work.id);
  await f.resources.patchStatus(get(), { execution: { id: "work-live", startedAt: new Date().toISOString() } });
  const tools = workContextTools(kind, f.resources, get, log);
  const note = tools.find(tool => tool.name === "upsert_note")!;
  const summarize = tools.find(tool => tool.name === `summarize_${kind}`)!;
  const call = (tool: typeof note, id: string, args: Record<string, unknown>) => tool.execute(id, args, undefined, undefined, {} as never);
  const before = get();
  await call(note, "start", { version: before.metadata.resourceVersion, text: "Investigation started" });
  const created = get().status.recent[0]!;
  await call(note, "progress", { version: get().metadata.resourceVersion, noteId: created.id, text: "Checks complete; external verification remains" });
  assert.equal(get().status.recent.length, 1);
  assert.equal(get().status.summary, before.status.summary);
  assert.equal(workPhase(get()), "running");
  await call(summarize, "rule", { version: get().metadata.resourceVersion, summary: "Reported success requires independent verification" });
  assert.equal(get().status.recent[0]!.id, created.id);
  assert.equal(workPhase(get()), "running");
  assert.match(JSON.stringify(relatedWork(f.aide.personal.store, "notes")), /external verification remains/);
  const memory = get().status;
  await reportWork(f.resources, get(), "work-live", { inputIds: [], report: "Checked available evidence", action: "done" });
  assert.equal(get().status.lastReport!.text, "Checked available evidence");
  assert.equal(get().status.summary, memory.summary);
  assert.deepEqual(get().status.recent, memory.recent);
  assert.equal(workPhase(get()), kind === "task" ? "ready" : "scheduled");
  await f.resources.patchStatus(get(), { execution: null });
  await assert.rejects(call(note, "late", { version: get().metadata.resourceVersion, text: "late write" }), /no longer active/);
});

test("Chief Person Notes preserve user corrections and cannot change identity or masquerade as Topic writes", async t => {
  const f = await setup(t);
  const person = await f.aide.persons.observe({ provider: "test", scope: "work", id: "A" }, "A");
  const corrected = await f.aide.persons.edit(person.metadata.name, person.metadata.uid, person.metadata.resourceVersion, person.spec, "Keep explicitly stated preferences");
  const tools = chiefNoteTools(f.aide.persons, (args, id) => upsertTopicNote(f.resources, f.read(), "live", args, id));
  const tool = tools[0]!;
  const target = { kind: "person", id: person.metadata.name, uid: person.metadata.uid };
  await tool.execute("started", { target, version: corrected.metadata.resourceVersion, text: "A says X has started" }, undefined, undefined, {} as never);
  const current = await f.aide.persons.read(person.metadata.name);
  assert.equal(current.status.summary, corrected.status.summary);
  assert.equal(current.status.updatedBy, "user", "Updating a Note preserves the summary correction's author");
  assert.equal(current.status.updatedAt, corrected.status.updatedAt);
  assert.deepEqual(current.spec.identities, person.spec.identities);
  assert.deepEqual(f.read().status.recent, []);
  await tool.execute("progress", { target, version: current.metadata.resourceVersion, noteId: current.status.recent[0]!.id,
    text: "A reports X complete; unverified" }, undefined, undefined, {} as never);
  const before = await f.aide.persons.read(person.metadata.name);
  const summarize = personTools(f.aide.persons).find(tool => tool.name === "summarize_person")!;
  await summarize.execute("summary", { id: before.metadata.name, uid: before.metadata.uid, version: before.metadata.resourceVersion, summary: "A's stable concern is verification" }, undefined, undefined, {} as never);
  assert.deepEqual((await f.aide.persons.read(person.metadata.name)).status.recent, before.status.recent);
  await assert.rejects(tool.execute("wrong", { target: { ...target, uid: "replaced" }, version: before.metadata.resourceVersion, text: "foreign" }, undefined, undefined, {} as never), /Unknown Person/);
});
