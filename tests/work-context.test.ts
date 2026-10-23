import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import definitions from "../plugins/personal/definitions.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../plugins/personal/input/model.ts";
import { CONVERSATION_TYPE } from "../plugins/personal/conversation/model.ts";
import { digest } from "../plugins/personal/chief-model.ts";
import { workType } from "../plugins/personal/resources.ts";
import { newWork } from "../plugins/personal/work.ts";
import type { WorkSpec, WorkResource } from "../plugins/personal/resources.ts";
import type { WorkStatus } from "../plugins/personal/model.ts";
import { consumeWorkInputs } from "../plugins/personal/work-input.ts";
import { executeWork, recordOutcome } from "../plugins/personal/execution.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { RECENT_CHARS, RECENT_COUNT } from "../plugins/personal/context.ts";

async function fixture(t: TestContext, kind: "task" | "routine" = "task") {
  const home = mkdtempSync(join(tmpdir(), "aide-work-context-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new PluginResourceStore({ home, pluginInstanceId: "personal" });
  store.storage.register("personal", definitions);
  const resources = createResourceClient(store);
  await resources.create(CONVERSATION_TYPE, { name: digest("me"), spec: { id: "me" }, status: {} });
  const work = newWork("me", { kind, title: "Follow up", instruction: "Check evidence", trigger: kind === "routine" ? { cron: "* * * * *", timezone: "UTC", event: null } : null });
  const { id, conversationId, title, instruction, revision, kind: _kind, trigger: _trigger, ...status } = work;
  const original = await resources.create<WorkSpec, WorkStatus>(workType(kind), { name: id, spec: { conversationId, title, instruction, revision, ...(kind === "routine" ? { trigger: work.trigger! } : {}) }, status });
  const context = { resources, logger: { info() {}, warn() {}, error() {} } } as unknown as PluginContext;
  const read = () => resources.get<WorkSpec, WorkStatus>(resourceRef(original)) as Promise<WorkResource>;
  const add = (name: string, text = name) => resources.create<InputSpec, InputStatus>(INPUT_TYPE, { name,
    spec: { origin: "source", originId: "test", text }, status: {
      route: { completedAt: new Date().toISOString(), result: { conversations: [], reason: "assigned" } },
      handle: { [original.metadata.uid]: { resource: resourceRef(original), assignedAt: new Date().toISOString(), request: { action: "context" } } },
    } });
  const pending = () => resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "handlePending", value: original.metadata.uid } });
  const run = async (handle: (prompt: string) => Promise<void> = async () => {}) => {
    const execution = { executionId: `work-test-${Date.now()}-${Math.random()}`, withContext() { return this; }, verbs: { async harness(args: { prompt: string; freshContext?: boolean }) {
      assert.equal(args.freshContext, true, "Work uses the bounded snapshot instead of replaying native history");
      await handle(args.prompt);
      return { state: "success", value: { outcome: "completed", invocationId: "test-invocation", result: { stopReason: "end_turn",
        finalText: JSON.stringify({ action: "done", summary: "Current verified progress", recent: "Checked evidence", notification: null, question: null, nextAt: null }) } } };
    } } } as unknown as ReconcileContext;
    const current = await consumeWorkInputs(context, await read());
    assert.ok(current);
    const completed = await executeWork(context, execution, current);
    if (completed) await recordOutcome(context, current, completed, work => { work.status = kind === "routine" ? "scheduled" : "done"; work.nextAt = null; });
  };
  return { context, original, resources, add, read, pending, run };
}

test("Work never acknowledges context before inference; bounded turns drain every input without losing primary text", async t => {
  const f = await fixture(t);
  for (let n = 0; n < 65; n++) await f.add(`fact-${n}`, `evidence-${n}:` + "x".repeat(2000));
  await consumeWorkInputs(f.context, await f.read());
  assert.equal((await f.pending()).length, 65);
  const seen = new Set<string>();
  for (let turn = 0; turn < 10 && (await f.pending()).length; turn++) await f.run(async prompt => {
    const material = JSON.parse(prompt.split("Work: ")[1]!.split("\n")[0]!);
    assert.ok(material.inputs.length > 0 && material.inputs.length <= 20);
    assert.ok(JSON.stringify(material.inputs).length < 65000);
    for (const input of material.inputs) { assert.equal(input.text.length > 2000, true); assert.ok(!seen.has(input.inputId)); seen.add(input.inputId); }
    assert.ok((await f.pending()).length > 0);
  });
  assert.equal(seen.size, 65);
  assert.equal((await f.pending()).length, 0);
  const work = await f.read();
  assert.equal(work.status.summary, "Current verified progress");
  assert.ok(work.status.recent.length <= RECENT_COUNT);
  assert.ok(work.status.recent.reduce((sum, entry) => sum + entry.text.length, 0) <= RECENT_CHARS);
});

test("Work confirms only the admitted snapshot; arrivals during inference remain pending", async t => {
  const f = await fixture(t); await f.add("first");
  await f.run(async () => { await f.add("late"); });
  assert.deepEqual((await f.pending()).map(i => i.metadata.name), ["late"]);
  await f.run();
  assert.equal((await f.pending()).length, 0);
});

test("Failed Work leaves contextual input unresolved and does not replay without explicit recovery", async t => {
  const f = await fixture(t); await f.add("uncertain");
  const current = (await consumeWorkInputs(f.context, await f.read()))!;
  const execution = { executionId: `work-test-${Date.now()}-${Math.random()}`, withContext() { return this; }, verbs: { async harness() { throw new Error("provider disconnected"); } } } as unknown as ReconcileContext;
  await executeWork(f.context, execution, current);
  assert.equal((await f.read()).status.status, "uncertain");
  let replayed = false;
  await f.run(async () => { replayed = true; });
  assert.equal(replayed, false);
  assert.match((await f.pending())[0]!.status.handle![f.original.metadata.uid]!.lastError!, /failed/);
  assert.equal((await f.pending()).length, 1);
  assert.equal((await f.pending())[0]!.status.handle![f.original.metadata.uid]!.completedAt, undefined);
});


test("A periodic Routine without new Input retains bounded context across many executions", async t => {
  const f = await fixture(t, "routine");
  for (let tick = 0; tick < 90; tick++) {
    await f.resources.patchStatus(await f.read(), { status: "scheduled", nextAt: "2000-01-01T00:00:00Z" });
    await f.run(async prompt => {
      const work = JSON.parse(prompt.split("Work: ")[1]!.split("\n")[0]!);
      assert.ok(work.recent.length <= RECENT_COUNT);
      assert.ok(prompt.length < 24000);
      assert.deepEqual(work.inputs, []);
    });
  }
  const current = await f.read();
  assert.equal(current.status.status, "scheduled");
  assert.equal(current.status.summary, "Current verified progress");
  assert.equal(current.status.recent.length, RECENT_COUNT);
});

test("Work result and Input confirmation roll back together; persistence retry never repeats inference", async t => {
  const f = await fixture(t); await f.add("atomic");
  let calls = 0;
  const execution = { executionId: "atomic-execution", withContext() { return this; }, verbs: { async harness() {
    calls++;
    return { state: "success", value: { outcome: "completed", invocationId: "harness-atomic", result: { stopReason: "end_turn",
      finalText: JSON.stringify({ action: "done", summary: "Verified", recent: "Checked", notification: null, question: null, nextAt: null }) } } };
  } } } as unknown as ReconcileContext;
  const current = (await consumeWorkInputs(f.context, await f.read()))!;
  const completed = (await executeWork(f.context, execution, current))!;
  const before = await f.read(), inputBefore = (await f.pending())[0]!;
  const failing = { ...f.context, resources: { ...f.resources,
    commit: (writes: Parameters<typeof f.resources.commit>[0]) => f.resources.commit([...writes,
      { operation: "create", type: { apiVersion: "aide.dev/v1alpha1", kind: "Unknown" }, name: "fail", spec: {}, status: {} }]),
  } };
  const finish = (work: import("../plugins/personal/model.ts").Work) => { work.status = "done"; };
  await assert.rejects(recordOutcome(failing, current, completed, finish), /Unknown resource/);
  assert.deepEqual(await f.read(), before);
  assert.deepEqual((await f.pending())[0], inputBefore);
  await recordOutcome(f.context, current, completed, finish);
  assert.equal(calls, 1);
  assert.equal((await f.pending()).length, 0);
  assert.equal((await f.read()).status.summary, "Verified");
});

test("Shared Input conflicts retry admission before the Harness, preserving other coordinator state", async t => {
  const f = await fixture(t); await f.add("shared");
  const current = (await consumeWorkInputs(f.context, await f.read()))!;
  let conflicted = false, calls = 0;
  const context = { ...f.context, resources: { ...f.resources, async commit(writes: Parameters<typeof f.resources.commit>[0]) {
    if (!conflicted && writes.some(write => write.operation === "patchStatus" && write.patch.status === "running")) {
      conflicted = true;
      const input = (await f.pending())[0]!;
      await f.resources.patchStatus(input, { route: { ...input.status.route, result: { conversations: [], reason: "Concurrent coordinator update" } } });
    }
    return f.resources.commit(writes);
  } } };
  const execution = { executionId: "admission-retry", withContext() { return this; }, verbs: { async harness() {
    calls++;
    return { state: "success", value: { outcome: "completed", invocationId: "harness-retry", result: { stopReason: "end_turn",
      finalText: JSON.stringify({ action: "done", summary: "Verified", recent: "Checked", notification: null, question: null, nextAt: null }) } } };
  } } } as unknown as ReconcileContext;
  const completed = (await executeWork(context, execution, current))!;
  await recordOutcome(context, current, completed, work => { work.status = "done"; });
  assert.equal(conflicted, true);
  assert.equal(calls, 1);
  assert.equal((await f.pending()).length, 0);
  const input = await f.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: "shared" });
  assert.equal(input!.status.route!.result!.reason, "Concurrent coordinator update");
});
