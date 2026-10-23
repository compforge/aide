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
import { workType, type WorkSpec } from "../plugins/personal/resources.ts";
import { newWork } from "../plugins/personal/work.ts";
import type { WorkAgentStatus } from "../plugins/personal/work-status.ts";
import { consumeWorkInputs } from "../plugins/personal/work-input.ts";
import { reportWork } from "../plugins/personal/work-report.ts";
import { finalizeExecution, runInput } from "../plugins/personal/loop.ts";
import { resourceRef, changeAttempt } from "../plugins/personal/input/state.ts";
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
  const original = await resources.create<WorkSpec, WorkAgentStatus>(workType(kind), { name: id, spec: { conversationId, title, instruction, revision, ...(kind === "routine" ? { trigger: work.trigger! } : { initialInputId: "fixture-initial" }) }, status });
  const context = { resources, logger: { info() {}, warn() {}, error() {} } } as unknown as PluginContext;
  const read = async () => (await resources.get<WorkSpec, WorkAgentStatus>(resourceRef(original)))!;
  const add = (name: string, text = name) => resources.create<InputSpec, InputStatus>(INPUT_TYPE, { name,
    spec: { origin: "source", originId: "test", text }, status: {
      route: { completedAt: new Date().toISOString(), result: { conversations: [], reason: "assigned" } },
      handle: { [original.metadata.uid]: { resource: resourceRef(original), assignedAt: new Date().toISOString(), request: { action: "context" } } },
    } });
  const pending = () => resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "handlePending", value: original.metadata.uid } });
  const admit = async (inputIds: string[], executionId = "run") => {
    await consumeWorkInputs(context, await read());
    await resources.patchStatus(await read(), { status: "running", execution: { id: executionId, startedAt: new Date().toISOString() } });
    for (const id of inputIds) await changeAttempt(resources, id, resourceRef(original), () => ({ executionId, startedAt: new Date().toISOString() }));
    return read();
  };
  const report = async (inputIds: string[]) => reportWork(resources, await read(), "run", { inputIds, action: "done", summary: "Current verified progress", recent: "Checked evidence" });
  return { context, original, resources, add, read, pending, admit, report };
}

test("Work intake preserves primary text and leaves receipts pending until explicit bounded reports", async t => {
  const f = await fixture(t);
  for (let n = 0; n < 65; n++) await f.add(`fact-${n}`, `evidence-${n}:` + "x".repeat(2000));
  await consumeWorkInputs(f.context, await f.read());
  assert.equal((await f.pending()).length, 65);
  const seen = new Set<string>();
  while ((await f.pending()).length) {
    const batch = (await f.pending()).slice(0, 20);
    const ids = batch.map(i => i.metadata.name);
    await f.admit(ids);
    for (const input of batch) { assert.ok(input.spec.text.length > 2000); assert.ok(!seen.has(input.metadata.name)); seen.add(input.metadata.name); }
    await f.report(ids);
    await finalizeExecution(f.context, await f.read(), "run");
  }
  assert.equal(seen.size, 65);
  assert.equal((await f.read()).status.summary, "Current verified progress");
});

test("Work report acknowledges exact admitted IDs; late arrivals remain pending", async t => {
  const f = await fixture(t); await f.add("first"); await f.admit(["first"]);
  await f.add("late");
  await f.report(["first"]);
  assert.equal((await f.read()).status.status, "ready");
  assert.deepEqual((await f.pending()).map(i => i.metadata.name), ["late"]);
  await finalizeExecution(f.context, await f.read(), "run");
  await f.admit(["late"]); await f.report(["late"]);
  assert.equal((await f.pending()).length, 0);
});

for (const kind of ["task", "routine"] as const)
test(`${kind} finalization preserves failed admission evidence for explicit recovery`, async t => {
  const f = await fixture(t, kind); await f.add("uncertain"); await f.admit(["uncertain"]);
  await finalizeExecution(f.context, await f.read(), "run", "provider disconnected");
  assert.equal((await f.read()).status.status, "uncertain");
  const receipt = (await f.pending())[0]!.status.handle![f.original.metadata.uid]!;
  assert.match(receipt.lastError!, /provider disconnected/);
  assert.equal(receipt.completedAt, undefined);
  assert.equal(receipt.executionId, "run");
  assert.equal((await f.read()).status.execution, null);
});

test("Periodic Routine reports retain bounded observations and schedule the next occurrence", async t => {
  const f = await fixture(t, "routine");
  for (let tick = 0; tick < 90; tick++) {
    await f.admit([]); await f.report([]);
    await finalizeExecution(f.context, await f.read(), "run");
    const current = await f.read();
    assert.equal(current.status.status, "scheduled");
    assert.ok(Date.parse(current.status.nextAt!) > Date.now());
    assert.ok(current.status.recent.length <= RECENT_COUNT);
    assert.ok(current.status.recent.reduce((sum, entry) => sum + entry.text.length, 0) <= RECENT_CHARS);
  }
  assert.equal((await f.read()).status.recent.length, RECENT_COUNT);
});

test("Work progress and receipts roll back together; tool persistence can retry without inference", async t => {
  const f = await fixture(t); await f.add("atomic"); await f.admit(["atomic"]);
  const before = await f.read(), inputBefore = (await f.pending())[0]!;
  const failing = { ...f.resources,
    commit: (writes: Parameters<typeof f.resources.commit>[0]) => f.resources.commit([...writes,
      { operation: "create", type: { apiVersion: "aide.dev/v1alpha1", kind: "Unknown" }, name: "fail", spec: {}, status: {} }]),
  };
  await assert.rejects(reportWork(failing, before, "run", { inputIds: ["atomic"], action: "done", summary: "Verified", recent: "Checked" }), /Unknown resource/);
  assert.deepEqual(await f.read(), before);
  assert.deepEqual((await f.pending())[0], inputBefore);
  await f.report(["atomic"]);
  assert.equal((await f.pending()).length, 0);
});

test("Shared Input admission conflicts occur before Harness effects; a fresh reconcile preserves other state", async t => {
  const f = await fixture(t); await f.add("shared");
  await consumeWorkInputs(f.context, await f.read());
  let conflicted = false, calls = 0;
  const context = { ...f.context, resources: { ...f.resources, async commit(writes: Parameters<typeof f.resources.commit>[0]) {
    if (!conflicted && writes.some(write => write.operation === "patchStatus" && write.patch.execution)) {
      conflicted = true;
      const input = (await f.pending())[0]!;
      await f.resources.patchStatus(input, { route: { ...input.status.route, result: { conversations: [], reason: "Concurrent coordinator update" } } });
    }
    return f.resources.commit(writes);
  } } };
  const execution = { executionId: "run", verbs: { async harness(args: { operation?: string }) {
    if (args.operation === "create") return { state: "success", value: { outcome: "accepted" }, agent: { harness: "task", sessionId: "native" } };
    calls++; await f.report(["shared"]);
    return { state: "success", value: { outcome: "completed", result: { stopReason: "end_turn" } } };
  } } } as unknown as ReconcileContext;
  await assert.rejects(runInput(context, execution, await f.read(), "task", "inspect", "shared"), /version conflict/);
  assert.equal(calls, 0);
  assert.equal((await f.read()).status.execution, undefined);
  await runInput(context, execution, await f.read(), "task", "inspect", "shared");
  assert.equal(calls, 1);
  assert.equal((await f.pending()).length, 0);
  const input = await f.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: "shared" });
  assert.equal(input!.status.route!.result!.reason, "Concurrent coordinator update");
});
