import { patchStatus } from "../plugins/personal/status.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { ResourceClient } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { createChildTopic, moveMaterial, moveTopic } from "../plugins/personal/topic/organize.ts";
import { maintenanceAgenda } from "../plugins/personal/topic/maintenance.ts";
import { resourceRef, assignmentWatch } from "../plugins/personal/input/state.ts";
import { deliver } from "../plugins/personal/route/delivery.ts";
import { TOPIC_TYPE, type TopicResource } from "../plugins/personal/topic/model.ts";
import { readTopicSubtree, understandingVersion } from "../plugins/personal/topic/tree.ts";
import { topicCandidates } from "../plugins/personal/background.ts";
import { TASK_TYPE, type TaskResource } from "../plugins/personal/task/model.ts";
import { ROUTINE_TYPE, type RoutineResource } from "../plugins/personal/routine/model.ts";
import { WEAVE_TYPE } from "../plugins/personal/weave/model.ts";
import { groupTopics } from "../plugins/personal/weave/service.ts";
const logger = { info() {}, warn() {}, error() {}, debug() {} };
async function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-ownership-"));
  const aide = new Aide(home, fakeOptions({ async execute() { throw new Error("No inference expected"); } }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const topic = await aide.topics.ensure("root");
  await resources.patchStatus(topic, { execution: { id: "chief", startedAt: new Date().toISOString() } });
  const root = () => aide.topics.resource("root")!;
  const child = () => createChildTopic(resources, root(), { name: "Aide ownership", summary: "Topic assignment", reason: "A coherent implementation topic" }, "child");
  const input = async (id: string) => {
    const fact = aide.topics.inputStore.submit("fixture", id, { origin: "source", originId: "fixture", text: `${id}: ${"recent evidence ".repeat(100)}` });
    await deliver({ resources, logger }, fact, [root().metadata], "Initial decision");
    return aide.topics.inputStore.get(id)!;
  };
  return { aide, resources, root, child, input };
}

test("Current Input ownership moves independently of immutable route and completed assessment", async t => {
  const f = await fixture(t), child = await f.child(), fact = await f.input("fact");
  const done = await patchStatus(f.resources, fact, { assess: { executionId: "chief", completedAt: new Date().toISOString(), result: { summary: "Reviewed" } } });
  const moved = await moveMaterial(f.resources, f.root(), { kind: "Input", id: "fact", topicUid: child.metadata.uid, reason: "Implementation evidence" });
  assert.equal(moved.status.topic!.uid, child.metadata.uid);
  assert.deepEqual(moved.status, { ...done.status, topic: resourceRef(child), organization: (moved.status as typeof done.status).organization });
  assert.equal(f.aide.topics.inputStore.query("topic", f.root().metadata.uid).length, 0);
  assert.equal(f.aide.topics.inputStore.query("topic", child.metadata.uid).length, 1);
  assert.equal(f.aide.topics.pending(f.root().metadata.uid).length, 0);
  const watch = assignmentWatch("assess", "Topic", f.resources);
  assert.deepEqual(await watch.handler.update!({ oldObject: done, newObject: moved } as never), [{ name: f.root().metadata.name, namespace: "v1" }]);
  await assert.rejects(f.resources.patchStatus(moved, { route: { ...done.status.route, result: { topics: [resourceRef(child)], reason: "rewrite" } } }), /routing receipt is immutable/);
});

test("Work moves without changing objective, schedule or history, and running consumers block reassignment", async t => {
  const f = await fixture(t), child = await f.child();
  const fact = await f.input("busy");
  await f.resources.patchStatus(fact, { assess: { executionId: "chief" } });
  await assert.rejects(moveMaterial(f.resources, f.root(), { kind: "Input", id: "busy", topicUid: child.metadata.uid, reason: "Move" }), /Finish Input/);
  const task = await f.aide.work("root").create({ kind: "task", title: "Implement", instruction: "Implement safely", trigger: null });
  const routine = await f.aide.work("root").create({ kind: "routine", title: "Observe", instruction: "Observe progress", trigger: { cron: "0 * * * *", timezone: "UTC", event: null } });
  for (const [kind, type, work] of [["Task", TASK_TYPE, task], ["Routine", ROUTINE_TYPE, routine]] as const) {
    const before = (await f.resources.get<TaskResource["spec"] | RoutineResource["spec"], TaskResource["status"]>({ ...type, namespace: "v1", name: work.id }))!;
    const moved = await moveMaterial(f.resources, f.root(), { kind, id: work.id, topicUid: child.metadata.uid, reason: "Implementation belongs here" });
    assert.deepEqual(moved.spec, before.spec);
    assert.equal((moved.spec as { topicId?: string }).topicId, undefined);
    assert.equal(f.aide.works().find(w => w.id === work.id)!.topicId, child.spec.id);
    assert.deepEqual((moved.status as import("../plugins/personal/model.ts").WorkStatus).waiting, before.status.waiting);
    assert.equal((moved.status as import("../plugins/personal/model.ts").WorkStatus).nextTriggerAt, (before.status as import("../plugins/personal/model.ts").WorkStatus).nextTriggerAt);
    await f.resources.patchStatus(moved as TaskResource, { execution: { id: "running-work", startedAt: new Date().toISOString() } });
    await assert.rejects(moveMaterial(f.resources, f.root(), { kind, id: work.id, topicUid: f.root().metadata.uid, reason: "Move back" }), /Finish Work/);
  }
  const outsider = await f.aide.topics.ensure("outside");
  await assert.rejects(moveMaterial(f.resources, f.root(), { kind: "Input", id: "busy", topicUid: outsider.metadata.uid, reason: "Cross tree" }), /outside/);
});

test("Detaching preserves a subtree, releases its root responsibility and prevents immediate Weave reversal", async t => {
  const f = await fixture(t), child = await f.child();
  const grandchild = await createChildTopic(f.resources, f.root(), { parentUid: child.metadata.uid, name: "Details", summary: "Details", reason: "Group details" }, "grandchild");
  await assert.rejects(moveTopic(f.resources, f.root(), { uid: child.metadata.uid, parentUid: grandchild.metadata.uid, reason: "Cycle" }), /cycle/);
  const independent = await moveTopic(f.resources, f.root(), { uid: child.metadata.uid, parentUid: null, reason: "Distinct sustained responsibility" });
  assert.equal(independent.spec.parentRef, undefined);
  assert.equal((await readTopicSubtree(f.resources, resourceRef(independent))).length, 2);
  assert.equal((await readTopicSubtree(f.resources, resourceRef(f.root()))).length, 1);
  const weave = await f.resources.create(WEAVE_TYPE, { name: "global", spec: {}, status: {} });
  await assert.rejects(groupTopics(f.resources, weave, { topics: [{ uid: independent.metadata.uid, version: understandingVersion(independent) }],
    parent: { uid: f.root().metadata.uid, version: understandingVersion(f.root()) } }, 4000), /cooling down/);
});

test("Concurrent grouping fences Chief material moves without partial ownership changes", async t => {
  const f = await fixture(t), child = await f.child(), fact = await f.input("race");
  const other = await f.aide.topics.ensure("other");
  let raced = false;
  const resources: ResourceClient = { ...f.resources, async commit(writes) {
    if (!raced) {
      raced = true;
      const root = f.root();
      await f.resources.replace(root, { ...root.spec, parentRef: resourceRef(other) }, root.status);
    }
    return f.resources.commit(writes);
  } };
  await assert.rejects(moveMaterial(resources, f.root(), { kind: "Input", id: "race", topicUid: child.metadata.uid, reason: "Move" }), /version conflict/);
  assert.deepEqual(f.aide.topics.inputStore.get("race")!.status.topic, fact.status.topic);
});

test("Maintenance counts direct ownership and Route includes bounded activity from descendants", async t => {
  const f = await fixture(t), child = await f.child();
  await f.input("one"); await f.input("two");
  const tree = () => readTopicSubtree(f.resources, resourceRef(f.root()));
  let agenda = await maintenanceAgenda(f.resources, await tree(), { maxInput: 1 });
  assert.equal(agenda.reason, "organize_material"); assert.equal(agenda.topics[0]!.uid, f.root().metadata.uid);
  await moveMaterial(f.resources, f.root(), { kind: "Input", id: "two", topicUid: child.metadata.uid, reason: "Specific subject" });
  agenda = await maintenanceAgenda(f.resources, await tree(), { maxInput: 1 });
  assert.equal(agenda.reason, "review", "moving one material resolves direct pressure without changing tree totals");
  const candidates = topicCandidates(f.aide.personal.store);
  const entry = candidates.find(c => c.uid === f.root().metadata.uid)!;
  assert.ok(entry.recent?.some(r => r.text.startsWith("two:")), "root activity covers descendants even with no summary");
  assert.ok(entry.recent!.length <= 3 && entry.recent!.every(r => r.text.length <= 240));
  assert.equal(entry.summary, undefined);
});

test("Maintenance agenda survives persistence for unnamed Topics and business Inputs precede queued reviews", async t => {
  const { createTriggerInput } = await import("../plugins/personal/topic/trigger.ts");
  const { nextInputs } = await import("../plugins/personal/loop.ts");
  const f = await fixture(t);
  await f.input("one"); await f.input("two");
  await f.resources.patchStatus(f.root(), { execution: null, nextTriggerAt: "2000-01-01T00:00:00.000Z" });
  const agenda = await maintenanceAgenda(f.resources, [f.root()], { maxInput: 1 });
  const review = await createTriggerInput({ resources: f.resources, logger }, f.root(), new Date(Date.now() + 60_000).toISOString(), agenda);
  assert.match(review.spec.text, /direct Input and Work ownership/);
  assert.deepEqual(review.spec.observation!.maintenance, agenda);
  const { inputPreview } = await import("../plugins/personal/input/prompt.ts");
  assert.ok(inputPreview(review).includes(`Maintenance facts: ${JSON.stringify(agenda)}`), "Chief receives the selected pressure and counts in automatic context");
  const ready = await nextInputs(f.resources, f.root(), 8);
  assert.equal(ready.at(-1)!.metadata.uid, review.metadata.uid);
  assert.equal((await maintenanceAgenda(f.resources, [f.root()], { maxInput: 1 })).topics[0]!.inputs, 2, "review Inputs never amplify maintenance pressure");
});
