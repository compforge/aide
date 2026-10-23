import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { Aide } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { fakeOptions } from "./fake-harness.ts";
import { deliver } from "../plugins/personal/route/delivery.ts";
import { TASK_TYPE, type TaskResource } from "../plugins/personal/task/model.ts";
import { INPUT_TYPE } from "../plugins/personal/input/model.ts";
import { resourceRef, changeAttempt } from "../plugins/personal/input/state.ts";
import { reportWork } from "../plugins/personal/work-report.ts";
import { reconcileTask } from "../plugins/personal/task/reconcile.ts";
import { finalizeExecution } from "../plugins/personal/loop.ts";
import { handoff } from "./input-state-fixture.ts";
const definition = { kind: "task" as const, title: "Check", instruction: "Inspect evidence", trigger: null };
const completed = { action: "done" as const, summary: "Verified", recent: "Inspected evidence", notification: null, question: null, nextAt: null };
function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-task-agent-"));
  const aide = new Aide(home, fakeOptions({ execute: async () => completed }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const context = { resources, instance: { config: { task: { agentIdleMs: 1000, idleRetentionMs: 1000 } } }, logger: { info() {}, warn() {} } } as unknown as PluginContext;
  const get = (id: string) => aide.personal.store.resources.get(TASK_TYPE, id) as TaskResource;
  async function active(id: string) {
    let task = get(id);
    await resources.patchStatus(task, { status: "running", execution: { id: "run", startedAt: new Date().toISOString() } });
    task = get(id);
    await changeAttempt(resources, task.spec.initialInputId, resourceRef(task), () => ({ executionId: "run", startedAt: new Date().toISOString() }));
    return task;
  }
  return { aide, resources, context, get, active };
}

/** @case Initial handling and Task creation are atomic, without prematurely completing Chief assessment. */
test("Task creation assigns the original Input atomically and distinguishes multiple goals from retries", async t => {
  const { aide, resources, context, get } = setup(t);
  const c = await aide.conversations.ensure("me");
  const input = await aide.conversations.submit("original", { origin: "channel", originId: "web", text: "inspect two repositories" });
  await deliver(context, input, [c.metadata], "same topic");
  const service = aide.work("me");
  const first = await service.create(definition, "original", "tool-1");
  const retry = await service.create(definition, "original", "tool-1");
  const second = await service.create({ ...definition, title: "Second repository" }, "original", "tool-2");
  assert.equal(first.uid, retry.uid);
  assert.notEqual(first.uid, second.uid);
  assert.equal(get(first.id).spec.initialInputId, "original");
  const fact = aide.conversations.inputStore.get("original")!;
  assert.equal(fact.status.assess![c.metadata.uid]!.completedAt, undefined);
  assert.deepEqual(Object.keys(fact.status.handle!).sort(), [first.uid!, second.uid!].sort());
  await assert.rejects(aide.work("other").create(definition, "original", "foreign"), /not assigned/);
  assert.deepEqual(aide.work("other").list(), []);
  await assert.rejects(resources.commit([
    { operation: "create", type: TASK_TYPE, name: "rolled-back", spec: { ...get(first.id).spec }, status: { ...get(first.id).status } },
    { operation: "create", type: { ...INPUT_TYPE, kind: "Unknown" }, name: "fail", spec: {}, status: {} },
  ]), /Unknown resource/);
  assert.equal(aide.personal.store.resources.find(TASK_TYPE, "rolled-back"), undefined);
  assert.deepEqual(aide.conversations.inputStore.get("original"), fact);
});

/** @case report_task alone acknowledges business handling, and rejects unrelated or unadmitted inputs atomically. */
test("Task report commits progress with exact receipts; end of inference without report stays uncertain", async t => {
  const { aide, resources, context, get, active } = setup(t);
  const work = await aide.work("me").create(definition);
  const task = await active(work.id);
  await aide.work("me").requestInput(work.id, { text: "later evidence" }, "later");
  const later = aide.conversations.inputStore.query("handlePending", work.uid!).find(i => i.metadata.name !== task.spec.initialInputId)!;
  const before = get(work.id);
  await assert.rejects(reportWork(resources, task, "run", { action: "done", summary: "Verified", recent: "Verified", inputIds: [task.spec.initialInputId, later.metadata.name] }), /not admitted/);
  assert.deepEqual(get(work.id), before);
  await assert.rejects(reportWork(resources, task, "wrong", { inputIds: [], summary: "bad", recent: "bad", action: "done" }), /no longer active/);
  await reportWork(resources, task, "run", { inputIds: [task.spec.initialInputId], summary: "First inspected", recent: "First evidence", action: "done" });
  assert.equal(get(work.id).status.status, "ready");
  assert.ok(aide.conversations.inputStore.get(task.spec.initialInputId)!.status.handle![work.uid!]!.completedAt);
  assert.equal(aide.conversations.inputStore.get(later.metadata.name)!.status.handle![work.uid!]!.completedAt, undefined);
  await finalizeExecution(context, task, "run");
  assert.equal(get(work.id).status.status, "ready");
  const another = await aide.work("me").create(definition);
  const unreported = await active(another.id);
  await finalizeExecution(context, unreported, "run");
  assert.equal(get(another.id).status.status, "uncertain");
  assert.match(aide.conversations.inputStore.get(unreported.spec.initialInputId)!.status.handle![another.uid!]!.lastError!, /interrupted/);
});

/** @case Input assignment and deletion serialize through the same Task version; neither can revive a deleting UID. */
test("Input assignment defeats stale idle deletion; deletion fences Chief handoff and independent requests", async t => {
  const { aide, resources, context, get } = setup(t);
  const work = await aide.work("me").create(definition);
  await resources.patchStatus(get(work.id), { idleSince: "2000-01-01T00:00:00Z", agentStoppedAt: "2000-01-01T00:00:00Z" });
  const stale = get(work.id);
  await aide.work("me").requestInput(work.id, { text: "new evidence" });
  assert.equal(get(work.id).status.idleSince, null);
  assert.equal(get(work.id).status.agentStoppedAt, null);
  await assert.rejects(resources.delete(TASK_TYPE, work.id, "v1", { uid: stale.metadata.uid, resourceVersion: stale.metadata.resourceVersion }), /version conflict/);
  const current = get(work.id);
  await resources.delete(TASK_TYPE, work.id, "v1", { uid: current.metadata.uid, resourceVersion: current.metadata.resourceVersion });
  assert.ok(get(work.id).metadata.deletionTimestamp);
  assert.deepEqual(aide.work("me").list(), []);
  await assert.rejects(aide.work("me").requestInput(work.id, { text: "too late" }), /Unknown work|being deleted/);
  const input = await aide.conversations.submit("late", { origin: "channel", originId: "web", text: "late request" });
  const c = aide.conversations.resource("me")!;
  await deliver(context, input, [c.metadata], "same topic");
  await assert.rejects(handoff(aide.conversations, resources, "late", [{ workUid: work.uid!, request: {} }]), /Work unavailable/);
  assert.equal(aide.conversations.inputStore.get("late")!.status.handle?.[work.uid!], undefined);
});

/** @case Agent stop precedes Task deletion; a future wake or unresolved handling prevents resource reclamation. */
test("Task idle lifecycle releases the agent, retains its native ID, then requests deletion", async t => {
  const { aide, resources, context, get, active } = setup(t);
  const work = await aide.work("me").create(definition);
  const task = await active(work.id);
  await reportWork(resources, task, "run", { inputIds: [task.spec.initialInputId], summary: "Verified", recent: "Verified", action: "done" });
  await finalizeExecution(context, task, "run");
  await resources.patchStatus(get(work.id), { agent: { harness: "task", sessionId: "native-id" } });
  let closes = 0;
  const execution = { verbs: { harness: async () => { closes++; return { state: "success", value: { outcome: "accepted" } }; } } } as unknown as ReconcileContext;
  await reconcileTask(context, execution, get(work.id));
  assert.equal(closes, 0);
  await resources.patchStatus(get(work.id), { idleSince: "2000-01-01T00:00:00Z" });
  await reconcileTask(context, execution, get(work.id));
  assert.equal(closes, 1);
  assert.ok(get(work.id).status.agentStoppedAt);
  assert.deepEqual(get(work.id).status.agent, { harness: "task", sessionId: "native-id" });
  assert.equal(get(work.id).metadata.deletionTimestamp, undefined);
  await aide.work("me").requestInput(work.id, { text: "Needs later inspection" }, "inspect-later");
  const unresolved = aide.conversations.inputStore.query("handlePending", work.uid!)[0]!;
  await resources.patchStatus(unresolved, { handle: { ...unresolved.status.handle, [work.uid!]: {
    ...unresolved.status.handle![work.uid!]!, appliedAt: new Date().toISOString(), executionId: "previous", lastError: "Needs inspection",
  } } });
  await resources.patchStatus(get(work.id), { idleSince: "2000-01-01T00:00:00Z", agentStoppedAt: "2000-01-01T00:00:00Z", status: "scheduled", nextAt: "2100-01-01T00:00:00Z" });
  assert.ok((await reconcileTask(context, execution, get(work.id)))!.requeueAfterMs! > 1000);
  assert.equal(get(work.id).metadata.deletionTimestamp, undefined);
  await resources.patchStatus(get(work.id), { status: "uncertain", nextAt: "2000-01-01T00:00:00Z" });
  assert.equal(await reconcileTask(context, execution, get(work.id)), undefined);
  assert.equal(get(work.id).metadata.deletionTimestamp, undefined);
  const { cancelAssignments } = await import("../plugins/personal/input/state.ts");
  await cancelAssignments(resources, resourceRef(get(work.id)), "handle");
  await resources.patchStatus(get(work.id), { status: "done", nextAt: null });
  await reconcileTask(context, execution, get(work.id));
  assert.ok(get(work.id).metadata.deletionTimestamp);
});

test("Task controller finalizes the resource after both idle stages without replaying completed input", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-task-finalize-"));
  let runs = 0;
  const options = fakeOptions({ execute: async () => { runs++; return completed; } }, home);
  const aide = new Aide(home, { ...options, config: ConfigSchema.parse({ plugins: { personal: { task: { agentIdleMs: 1000, idleRetentionMs: 1000 } } } }) }, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  await aide.start();
  const work = await aide.work("me").create(definition);
  await aide.settled();
  assert.equal(aide.work("me").read(work.id).status, "done");
  for (let n = 0; n < 350 && aide.personal.store.resources.find(TASK_TYPE, work.id); n++) await Bun.sleep(10);
  assert.equal(aide.personal.store.resources.find(TASK_TYPE, work.id), undefined);
  assert.equal(runs, 1);
  assert.ok(aide.conversations.inputStore.list().every(i => i.status.handle?.[work.uid!]?.completedAt));
});
