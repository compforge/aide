import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import definitions from "../plugins/personal/definitions.ts";
import { setConditions, conditionTrue } from "../plugins/personal/conditions.ts";
import { inputStatus, patchStatus, commitStatus, workPhase } from "../plugins/personal/status.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../plugins/personal/input/model.ts";
import { TOPIC_TYPE, type TopicResource } from "../plugins/personal/topic/model.ts";
import { TASK_TYPE } from "../plugins/personal/task/model.ts";
import { ROUTINE_TYPE } from "../plugins/personal/routine/model.ts";
import type { WorkSpec, WorkResource } from "../plugins/personal/resources.ts";
import type { WorkAgentStatus } from "../plugins/personal/work-status.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { reportWork } from "../plugins/personal/work-report.ts";
import { refreshSummaryConditions } from "../plugins/personal/topic/conditions.ts";
import { summaryVersion } from "../plugins/personal/topic/tree.ts";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-status-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const store = new PluginResourceStore({ home, pluginInstanceId: "personal" });
  store.storage.register("personal", definitions);
  const resources = createResourceClient(store);
  const topic = async (name: string, parent?: TopicResource) => resources.create<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE, { name,
    spec: { id: name, ...(parent ? { parentRef: resourceRef(parent) } : {}) }, status: { summary: "", recent: [], receipts: [] } });
  return { store, resources, topic };
}

test("Condition updates preserve other owners and only status transitions advance transition time", () => {
  const value = { type: "Succeeded", status: "False" as const, reason: "Pending", message: "", observedGeneration: 1 };
  const first = setConditions([], [value, { ...value, type: "OtherOwner" }], "2026-01-01T00:00:00.000Z");
  const changed = setConditions(first, [{ ...value, reason: "UpdatedGoal", observedGeneration: 2 }], "2026-01-02T00:00:00.000Z");
  assert.equal(changed[0]!.lastTransitionTime, first[0]!.lastTransitionTime);
  assert.deepEqual(changed[1], first[1]);
  const done = setConditions(changed, [{ ...value, status: "True", observedGeneration: 2 }], "2026-01-03T00:00:00.000Z");
  assert.equal(done[0]!.lastTransitionTime, "2026-01-03T00:00:00.000Z");
  assert.ok(conditionTrue(done, "Succeeded", 2));
  assert.equal(conditionTrue(done, "Succeeded", 3), false);
});

test("Input conditions follow exact receipts atomically and stale writers cannot overwrite a completed assessment", async t => {
  const f = fixture(t), root = await f.topic("root"), at = new Date().toISOString();
  const input = await f.resources.create<InputSpec, InputStatus>(INPUT_TYPE, { name: "fact", spec: { origin: "source", originId: "fixture", text: "evidence" }, status: inputStatus({ topic: resourceRef(root), assess: {} }) });
  const assessed = await patchStatus(f.resources, input, { assess: { completedAt: at, result: { summary: "Reviewed" } },
    handle: { worker: { resource: { ...TASK_TYPE, namespace: "v1", name: "task", uid: "worker" }, assignedAt: at, request: { action: "context" } } } });
  assert.ok(conditionTrue(assessed.status.conditions, "Assessed"));
  assert.equal(conditionTrue(assessed.status.conditions, "HandlingComplete"), false);
  await assert.rejects(patchStatus(f.resources, input, { assess: { lastError: "stale" } }), /version conflict/);
  await assert.rejects(commitStatus(f.resources, [
    { operation: "patchStatus", resource: assessed, patch: { handle: { worker: { ...assessed.status.handle!.worker!, completedAt: at } } } },
    { operation: "create", type: { ...INPUT_TYPE, kind: "Missing" }, name: "fail", spec: {}, status: {} },
  ]), /Unknown resource/);
  assert.deepEqual(await f.resources.get(resourceRef(input)), assessed);
  const done = await patchStatus(f.resources, assessed, { handle: { worker: { ...assessed.status.handle!.worker!, completedAt: at, result: { summary: "Cancelled", disposition: "cancelled" } } } });
  assert.ok(conditionTrue(done.status.conditions, "HandlingComplete"), "settled does not imply every Work succeeded");
  assert.equal(done.status.conditions![0]!.lastTransitionTime, assessed.status.conditions![0]!.lastTransitionTime);
});

test("Task completion is generation-bound; Routine completion records one occurrence and remains operational", async t => {
  const f = fixture(t), root = await f.topic("root");
  for (const type of [TASK_TYPE, ROUTINE_TYPE]) {
    const routine = type.kind === "Routine";
    const spec: WorkSpec = { title: "Observe", instruction: "Check evidence", paused: false,
      ...(routine ? { trigger: { cron: "0 * * * *", timezone: "UTC", event: null } } : { initialInputId: "fact" }) };
    await commitStatus(f.resources, [{ operation: "create", type, name: type.kind, spec, status: { topic: resourceRef(root), summary: "", recent: [],
      execution: { id: "run", startedAt: new Date().toISOString(), observedGeneration: 1 } } }]);
    const read = async () => (await f.resources.get<WorkSpec, WorkAgentStatus>({ ...type, namespace: "v1", name: type.kind }))!;
    const work = await read();
    await reportWork(f.resources, work, "run", { inputIds: [], action: "done", report: "Verified" });
    const done = await read();
    assert.ok(conditionTrue(done.status.conditions, routine ? "Operational" : "Succeeded", 1));
    if (routine) { assert.ok(done.status.lastOccurrence); assert.equal(done.status.completion, undefined); assert.ok(done.status.nextTriggerAt); }
    else {
      assert.ok(done.status.completion); assert.equal(done.status.lastOccurrence, undefined);
      await commitStatus(f.resources, [{ operation: "replace", resource: done, spec: { ...done.spec, instruction: "New goal" }, status: done.status }]);
      const changed = await read();
      assert.equal(changed.metadata.generation, 2);
      assert.equal(conditionTrue(changed.status.conditions, "Succeeded", 2), false);
      assert.equal(workPhase(changed), "ready");
      await assert.rejects(reportWork(f.resources, changed, "run", { inputIds: [], action: "done", report: "Old goal", observedGeneration: 1 }), /spec changed/);
      assert.deepEqual(await read(), changed, "stale reports cannot complete newer goals or their Inputs");
      await reportWork(f.resources, changed, "run", { inputIds: [], action: "done", report: "Verified updated goal", observedGeneration: 2 });
      assert.ok(conditionTrue((await read()).status.conditions, "Succeeded", 2));
    }
  }
});

test("Topic summary condition tracks child versions without global queries and fences concurrent changes", async t => {
  const f = fixture(t), root = await f.topic("root"), child = await f.topic("child", root);
  let reviewed = await refreshSummaryConditions(f.resources, root);
  assert.equal(conditionTrue(reviewed.status.conditions, "SummaryCurrent"), false);
  reviewed = await patchStatus(f.resources, reviewed, { absorbedSummaries: { [child.metadata.uid]: summaryVersion(child) } });
  reviewed = await refreshSummaryConditions(f.resources, reviewed);
  assert.ok(conditionTrue(reviewed.status.conditions, "SummaryCurrent"));
  const updated = await patchStatus(f.resources, (await f.resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(child)))!, { summary: "New understanding" });
  const raced = { ...f.resources, async commit(writes: Parameters<typeof f.resources.commit>[0]) {
    await patchStatus(f.resources, updated, { summary: "Changed during observation" });
    return f.resources.commit(writes);
  } };
  await assert.rejects(refreshSummaryConditions(raced, reviewed), /version conflict/);
  const after = await refreshSummaryConditions(f.resources, reviewed);
  assert.equal(conditionTrue(after.status.conditions, "SummaryCurrent"), false);
  assert.notEqual(after.status.summaryDependencies![child.metadata.uid], summaryVersion(child));
});

test("Domain v1alpha2 schemas reject the former Work state bag and do not read old-version identities", async t => {
  const f = fixture(t), root = await f.topic("root");
  assert.ok([INPUT_TYPE, TASK_TYPE, ROUTINE_TYPE, TOPIC_TYPE].every(type => type.apiVersion === "aide.dev/v1alpha2"));
  await assert.rejects(f.resources.create(TASK_TYPE, { name: "old-shape", spec: { title: "old", instruction: "old", initialInputId: "fact", revision: 1 },
    status: { topic: resourceRef(root), status: "done", nextAt: null, question: null } }));
  const oldType = { ...TOPIC_TYPE, apiVersion: "aide.dev/v1alpha1" };
  f.store.storage.register("personal", [{ type: oldType, schema: { spec: { parse: (v: unknown) => v }, status: { parse: (v: unknown) => v } } }]);
  const old = await f.resources.create(oldType, { name: "old-only", spec: { id: "old-only" }, status: {} });
  assert.equal(await f.resources.get({ ...TOPIC_TYPE, name: old.metadata.name, namespace: "v1" }), undefined);
  assert.equal((await f.resources.list(TOPIC_TYPE)).length, 1);
});
