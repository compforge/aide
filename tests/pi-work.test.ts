import type { PluginContext } from "@compforge/aide-plugin";
import { consumeWorkInputs } from "../plugins/personal/work-input.ts";
import type { WorkResource } from "../plugins/personal/resources.ts";
import { createResourceClient } from "../src/host/plugin/resource-client.ts";
import { ConversationStore, seedInput } from "./conversation-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { Store, message } from "../plugins/personal/store.ts";
import { WorkService, AppendInputSchema, type WorkDefinition } from "../plugins/personal/work.ts";
import { workType } from "../plugins/personal/resources.ts";
import { TASK_TYPE } from "../plugins/personal/task/model.ts";
import { ROUTINE_TYPE } from "../plugins/personal/routine/model.ts";
import { SessionStore } from "../src/host/store/store.ts";
import { PluginResourceStore } from "../src/host/plugin/resource.ts";
import { fakeOptions } from "./fake-harness.ts";

const log = pino({ level: "silent" });
const task: WorkDefinition = { kind: "task", title: "检查仓库", instruction: "检查 aide 仓库", trigger: null };
function setup(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "aide-work-tools-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const session = new SessionStore(root).createSession({ cwd: root });
  let writes = 0;
  const resources = new PluginResourceStore({ session, pluginInstanceId: "personal" });
  const store = new Store(resources, createResourceClient(resources, () => writes++), new ConversationStore(session));
  const consume = async (id: string) => {
    const work = store.get(id);
    return consumeWorkInputs({ resources: createResourceClient(resources), logger: { info() {}, warn() {} } } as unknown as PluginContext,
      resources.get(workType(work.kind), id) as WorkResource);
  };
  return { store, consume, service: new WorkService(store, "me", log), writes: () => writes };
}

for (const definition of [task, { ...task, kind: "routine" as const, trigger: { cron: "0 9 * * *", timezone: "UTC", event: null } }])
test(`${definition.kind} CRUD preserves identity, enforces revisions and conversation scope, and archives delivery on deletion`, async (t) => {
  const { store, service, writes, consume } = setup(t);
  const work = (await service.create(definition));
  const type = workType(definition.kind);
  const uid = store.resources.get(type, work.id).metadata.uid;
  const response = message("me", "已接下", work.id);
  (await store.save(work, [response], "accepted-input"));
  assert.equal(service.list().length, 1);
  const beforeRead = writes();
  assert.equal(service.read(work.id).kind, definition.kind);
  assert.equal(writes(), beforeRead);
  const appended = await service.appendInput(work.id, { action: "update", text: "修改目标",
    changes: { instruction: "检查更新后的 aide 仓库" } }, "request-1");
  assert.equal(appended.instruction, definition.instruction);
  assert.equal(appended.status, work.status);
  await service.appendInput(work.id, { action: "update", text: "修改目标", changes: { instruction: "检查更新后的 aide 仓库" } }, "request-1");
  assert.equal(service.read(work.id).inputs.length, 1);
  await consume(work.id);
  const updated = service.read(work.id);
  assert.equal(updated.kind, definition.kind);
  assert.equal(updated.instruction, "检查更新后的 aide 仓库");
  assert.equal(updated.status, definition.kind === "routine" ? "scheduled" : "ready");
  assert.equal(store.resources.get(type, work.id).metadata.uid, uid);
  await assert.rejects(async () => (await service.delete(work.id, 1)), /revision changed/);
  const other = new WorkService(store, "other", log);
  assert.deepEqual(other.list(), []);
  assert.throws(() => other.read(work.id), /Unknown work/);
  await assert.rejects(async () => (await other.delete(work.id, updated.revision)), /Unknown work/);
  (await service.delete(work.id, updated.revision));
  assert.deepEqual(service.list(), []);
  assert.equal(store.response("accepted-input")?.id, response.id);
  assert.equal(store.read().messages.filter((item) => item.id === response.id).length, 1);
});

test("Work Reconcile validates requests and only explicit control can resume paused work", async (t) => {
  const { store, service, consume } = setup(t);
  await assert.rejects(service.create({ ...task, kind: "routine" }), /Routine needs/);
  const work = await service.create(task);
  assert.throws(() => AppendInputSchema.parse({ action: "update", text: "change", changes: { kind: "routine" } }), /Unrecognized key/);
  await service.appendInput(work.id, { action: "update", text: "change", changes: { trigger: { cron: "0 9 * * *", timezone: "UTC", event: null } } });
  await consume(work.id);
  assert.equal(service.read(work.id).trigger, null);
  assert.match(service.read(work.id).history.at(-1)!.text, /Task cannot/);
  await service.appendInput(work.id, { action: "pause", text: "暂停" }); await consume(work.id);
  assert.equal(service.read(work.id).status, "paused");
  await seedInput(store.conversations, "pod", { conversationId: "me", origin: "source", originId: "personal.environments", text: "Pod replaced" });
  await service.appendInput(work.id, { inputId: "pod", text: "相关服务变化" });
  await service.appendInput(work.id, { inputId: "pod", text: "相关服务变化" });
  await assert.rejects(service.appendInput(work.id, { inputId: "pod", action: "resume" }), /Source facts/);
  await assert.rejects(service.appendInput(work.id, { inputId: "missing" }), /does not belong/);
  await consume(work.id);
  const paused = service.read(work.id);
  assert.equal(paused.status, "paused");
  assert.equal(paused.inputs.filter((i) => i.inputId === "pod").length, 1);
  assert.match(paused.history.at(-1)!.text, /Pod replaced/);
  await service.appendInput(work.id, { action: "resume", text: "继续" }); await consume(work.id);
  assert.equal(service.read(work.id).status, "ready");
  assert.equal(service.read(work.id).consumedInputIds.length, service.read(work.id).inputs.length);
});

test("Work service writes wake the existing Worker and reconcile; deletion during execution cannot recreate work", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-pi-reconcile-"));
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const running = new Promise<void>((resolve) => { started = resolve; });
  const aide = new Aide(root, fakeOptions({ chief: async () => { throw new Error("No conversation expected"); },
    execute: async () => { started(); await gate;
      return { action: "done", summary: "checked", notification: "完成", question: null, nextAt: null }; },
  }, root), log);
  t.after(async () => { release(); await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.start();
  const tools = aide.work("me");
  const work = (await tools.create(task));
  await running;
  assert.equal(tools.read(work.id).status, "running");
  (await tools.delete(work.id, work.revision));
  release(); await aide.settled();
  assert.deepEqual(tools.list(), []);
  assert.equal(aide.messages().length, 0);
  assert.equal(aide.session("me").store.resources.find(TASK_TYPE, work.id), undefined);
});


test("Work view aggregates separate Task and Routine resources without persisting spec.kind", async (t) => {
  const { store, service } = setup(t);
  const finite = (await service.create(task));
  const recurring = (await service.create({ ...task, kind: "routine", trigger: { cron: null, timezone: "UTC", event: "changed" } }));
  const taskResource = store.resources.get(TASK_TYPE, finite.id);
  const routineResource = store.resources.get(ROUTINE_TYPE, recurring.id);
  assert.equal(taskResource.kind, "Task");
  assert.equal(routineResource.kind, "Routine");
  assert.equal("kind" in taskResource.spec, false);
  assert.equal("kind" in routineResource.spec, false);
  assert.equal("trigger" in taskResource.spec, false);
  assert.equal((routineResource.spec.trigger as { event: string }).event, "changed");
  assert.deepEqual(service.list().map((work) => work.kind).sort(), ["routine", "task"]);
  assert.equal(store.resources.list({ apiVersion: TASK_TYPE.apiVersion, kind: "Work" }).length, 0);
  const reply = message("me", "routine result", recurring.id);
  (await store.save(recurring, [reply], "routine-input", "event-1"));
  assert.equal(store.hasEvent(recurring.id, "event-1"), true);
  assert.equal(store.response("routine-input")?.id, reply.id);
  assert.equal(store.read().messages.length, 1);
});

/** @case A shared source fact is routed through Chief, then consumed independently by existing Task and Routine. */
test("Chief appends the same original Input to two works without losing observation or resuming a paused task", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-work-input-handoff-"));
  let aide: Aide, taskId = "", routineId = "", executions = 0;
  const observation = { type: "workload.changed", environment: "test", changes: [{ service: "executor", image: "v2" }] };
  aide = new Aide(root, fakeOptions({ chief: async (prompt) => {
    const input = JSON.parse(prompt.split("Activation: ")[1]!.split("\n")[0]!);
    assert.equal(input.inputId, "changed");
    for (const id of [taskId, routineId]) await aide.work("me").appendInput(id, { inputId: input.inputId, text: "核对 executor 变化" });
    return "已交给相关工作核对。";
  }, execute: async (work) => {
    executions++;
    assert.equal(work.id, routineId);
    assert.deepEqual(work.inputs[0]!.observation, observation);
    assert.equal(work.inputs[0]!.text, "executor workload changed");
    assert.equal(work.inputs[0]!.note, "核对 executor 变化");
    return { action: "done", summary: "verified", notification: null, question: null, nextAt: null };
  } }, root), log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const taskWork = await aide.work("me").create(task); taskId = taskWork.id;
  await aide.session("me").store.save({ ...taskWork, status: "paused" });
  routineId = (await aide.work("me").create({ ...task, kind: "routine", trigger: { cron: null, timezone: "UTC", event: "deployment" } })).id;
  await aide.start(); await aide.settled();
  const source = aide.session("source"); await source.start();
  const fact = { origin: "source" as const, originId: "personal.environments", sessionId: "me", text: "executor workload changed", observation };
  await source.conversations.submit("changed", fact); await aide.settled();
  assert.equal(aide.work("me").read(taskId).status, "paused");
  assert.equal(aide.work("me").read(routineId).status, "scheduled");
  for (const id of [taskId, routineId]) {
    const current = aide.work("me").read(id);
    assert.equal(current.inputs.length, 1); assert.equal(current.consumedInputIds.length, 1);
    assert.equal(current.inputs[0]!.inputId, "changed");
  }
  await source.conversations.submit("changed", fact); await aide.settled();
  assert.equal(executions, 1);
  assert.equal(aide.works().length, 2);
});
