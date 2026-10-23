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
import { ROUTINE_TYPE, type RoutineResource } from "../plugins/personal/routine/model.ts";
import { resourceRef, changeAttempt } from "../plugins/personal/input/state.ts";
import { reportWork } from "../plugins/personal/work-report.ts";
import { reconcileRoutine } from "../plugins/personal/routine/reconcile.ts";
import { finalizeExecution } from "../plugins/personal/loop.ts";
import { deliver } from "../plugins/personal/route/delivery.ts";
import { handoff } from "./input-state-fixture.ts";
const definition = { kind: "routine" as const, title: "Watch", instruction: "Inspect changes", trigger: { cron: null, timezone: "UTC", event: "sample" } };
const completed = { action: "done" as const, summary: "Verified", recent: "Inspected evidence", notification: null, question: null, nextAt: null };
function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-routine-agent-"));
  const aide = new Aide(home, fakeOptions({ execute: async () => completed }, home), pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const resources = aide.runtime.plugins.resourceClient("personal");
  const context = { resources, instance: { config: { routine: { agentIdleMs: 1000 } } }, logger: { info() {}, warn() {} } } as unknown as PluginContext;
  const get = (id: string) => aide.personal.store.resources.get(ROUTINE_TYPE, id) as RoutineResource;
  async function active(id: string, inputIds: string[] = []) {
    const routine = await resources.patchStatus(get(id), { status: "running", execution: { id: "run", startedAt: new Date().toISOString() } });
    for (const inputId of inputIds) await changeAttempt(resources, inputId, resourceRef(routine), () => ({ executionId: "run", startedAt: new Date().toISOString() }));
    return routine;
  }
  return { aide, resources, context, get, active };
}

/** @case A timer occurrence needs an explicit report even with no Input; done retains the recurring mandate. */
test("Routine report distinguishes done, ask and wait and preserves a concurrent pause", async t => {
  const { aide, resources, context, get, active } = setup(t);
  const work = await aide.work("me").create({ ...definition, trigger: { cron: "0 9 * * *", timezone: "UTC", event: null } });
  const report = async (args: object) => reportWork(resources, get(work.id), "run", { inputIds: [], summary: "Verified", recent: "Evidence", ...args });
  await active(work.id);
  for (const args of [{ action: "ask" }, { action: "wait", nextAt: "2000-01-01T00:00:00Z" }, { action: "done", summary: "" }]) await assert.rejects(report(args));
  assert.equal(get(work.id).status.status, "running");
  await report({ action: "done" });
  assert.equal(get(work.id).status.status, "scheduled");
  assert.ok(Date.parse(get(work.id).status.nextAt!) > Date.now());
  await report({ action: "ask", question: "Which repository?" });
  assert.equal(get(work.id).status.status, "waiting");
  assert.equal(get(work.id).status.question, "Which repository?");
  assert.equal(get(work.id).status.nextAt, null);
  await report({ action: "wait", nextAt: "2100-01-01T00:00:00Z" });
  assert.equal(get(work.id).status.nextAt, "2100-01-01T00:00:00Z");
  await resources.patchStatus(get(work.id), { status: "paused" });
  await report({ action: "done" });
  assert.equal(get(work.id).status.status, "paused");
  await finalizeExecution(context, get(work.id), "run");
  assert.equal(get(work.id).status.status, "paused");
  await active(work.id); await finalizeExecution(context, get(work.id), "run");
  assert.equal(get(work.id).status.status, "uncertain");
});

/** @case Idle time starts after execution settles; release retains the native ID and never deletes the Routine. */
test("Routine silence releases only the agent; events clear idle state and deletion fences new assignments", async t => {
  const { aide, resources, context, get, active } = setup(t);
  const work = await aide.work("me").create(definition);
  await active(work.id);
  await reportWork(resources, get(work.id), "run", { inputIds: [], action: "done", summary: "Checked", recent: "No changes" });
  await finalizeExecution(context, get(work.id), "run");
  assert.equal(get(work.id).status.nextAt, null);
  await resources.patchStatus(get(work.id), { agent: { harness: "routine", sessionId: "native-id" } });
  let closes = 0;
  const execution = { verbs: { harness: async () => { closes++; return { state: "success", value: { outcome: "accepted" } }; } } } as unknown as ReconcileContext;
  await reconcileRoutine(context, execution, get(work.id));
  assert.equal(closes, 0);
  assert.ok(get(work.id).status.idleSince);
  await resources.patchStatus(get(work.id), { idleSince: "2000-01-01T00:00:00Z" });
  await reconcileRoutine(context, execution, get(work.id));
  assert.equal(closes, 1);
  assert.ok(get(work.id).status.agentStoppedAt);
  assert.deepEqual(get(work.id).status.agent, { harness: "routine", sessionId: "native-id" });
  await resources.patchStatus(get(work.id), { agentStoppedAt: "2000-01-01T00:00:00Z" });
  await reconcileRoutine(context, execution, get(work.id));
  assert.equal(closes, 1);
  assert.equal(get(work.id).metadata.deletionTimestamp, undefined);
  const stale = get(work.id);
  await aide.event({ id: "wake", conversationId: "me", sessionId: "me", name: "sample", text: "changed" });
  assert.equal(get(work.id).status.idleSince, null);
  assert.equal(get(work.id).status.agentStoppedAt, null);
  await aide.work("me").requestInput(work.id, { text: "user context" });
  await assert.rejects(resources.delete(ROUTINE_TYPE, work.id, "v1", { uid: stale.metadata.uid, resourceVersion: stale.metadata.resourceVersion }), /version conflict/);
  await resources.delete(ROUTINE_TYPE, work.id, "v1");
  await assert.rejects(aide.work("me").requestInput(work.id, { text: "too late" }), /Unknown work|being deleted/);
  assert.equal(await aide.event({ id: "late-event", conversationId: "me", sessionId: "me", name: "sample", text: "late" }), 0);
  const input = await aide.conversations.submit("late", { origin: "channel", originId: "web", text: "late request" });
  const c = aide.conversations.resource("me")!;
  await deliver(context, input, [c.metadata], "same topic");
  await assert.rejects(handoff(aide.conversations, resources, "late", [{ workUid: work.uid!, request: {} }]), /Work unavailable/);
  await reconcileRoutine(context, execution, get(work.id));
  assert.equal(aide.conversations.inputStore.query("handlePending", work.uid!).length, 0);
});

/** @case A released Routine remains timer-driven and an unreported timer execution is never replayed automatically. */
test("Routine timer wake preserves the native identity; a missing report blocks automatic replay", async t => {
  const { aide, resources, context, get } = setup(t);
  const work = await aide.work("me").create(definition);
  await resources.patchStatus(get(work.id), { status: "scheduled", nextAt: "2100-01-01T00:00:00Z", idleSince: "2000-01-01T00:00:00Z", agentStoppedAt: "2000-01-01T00:00:00Z", agent: { harness: "routine", sessionId: "native-id" } });
  let prompts = 0;
  const execution = { executionId: "timer", withContext() { return this; }, verbs: { async harness(args: { sessionId: string; prompt: string }) {
    prompts++;
    assert.equal(args.sessionId, "native-id");
    assert.match(args.prompt, /"kind":"timer"/);
    assert.equal(get(work.id).status.idleSince, null);
    return { state: "success", value: { outcome: "completed", result: { stopReason: "end_turn", finalText: "done" } } };
  } } } as unknown as ReconcileContext;
  assert.ok((await reconcileRoutine(context, execution, get(work.id)))!.requeueAfterMs! > 1000);
  assert.equal(prompts, 0);
  await resources.patchStatus(get(work.id), { nextAt: "2000-01-01T00:00:00Z" });
  await reconcileRoutine(context, execution, get(work.id));
  assert.equal(prompts, 1);
  assert.equal(get(work.id).status.status, "uncertain");
  await reconcileRoutine(context, execution, get(work.id));
  assert.equal(prompts, 1);
});

test("Routine controller releases an idle session and resumes on a later event without collecting the resource", async t => {
  const home = mkdtempSync(join(tmpdir(), "aide-routine-idle-"));
  let runs = 0;
  const options = fakeOptions({ execute: async () => { runs++; return completed; } }, home);
  const aide = new Aide(home, { ...options, config: ConfigSchema.parse({ plugins: { personal: { routine: { agentIdleMs: 1000 } } } }) }, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  const work = await aide.work("me").create(definition);
  const get = () => aide.personal.store.resources.get(ROUTINE_TYPE, work.id) as RoutineResource;
  await aide.event({ id: "first", sessionId: "me", conversationId: "me", name: "sample", text: "first" });
  await aide.start(); await aide.settled();
  const agent = get().status.agent;
  for (let n = 0; n < 250 && !get().status.agentStoppedAt; n++) await Bun.sleep(10);
  assert.ok(get().status.agentStoppedAt);
  assert.equal(get().metadata.deletionTimestamp, undefined);
  await aide.event({ id: "second", sessionId: "me", conversationId: "me", name: "sample", text: "second" });
  await aide.settled();
  assert.equal(runs, 2);
  assert.equal(get().status.status, "scheduled");
  assert.deepEqual(get().status.agent, agent);
  assert.equal(get().status.agentStoppedAt, null);
});
