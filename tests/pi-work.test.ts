import { createResourceClient } from "../src/host/plugin/resource-client.ts";
import { ConversationStore } from "../src/host/conversation/store.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { Store, message } from "../plugins/personal/store.ts";
import { WorkService, WorkUpdateSchema, type WorkDefinition } from "../plugins/personal/work.ts";
import { TASK_TYPE, ROUTINE_TYPE, workType } from "../plugins/personal/resources.ts";
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
  return { store, service: new WorkService(store, "me", log), writes: () => writes };
}

for (const definition of [task, { ...task, kind: "routine" as const, trigger: { cron: "0 9 * * *", timezone: "UTC", event: null } }])
test(`${definition.kind} CRUD preserves identity, enforces revisions and conversation scope, and archives delivery on deletion`, async (t) => {
  const { store, service, writes } = setup(t);
  const work = (await service.create(definition));
  const type = workType(definition.kind);
  const uid = store.resources.get(type, work.id).metadata.uid;
  const response = message("me", "已接下", work.id);
  (await store.save(work, [response], "accepted-input"));
  assert.equal(service.list().length, 1);
  const beforeRead = writes();
  assert.equal(service.read(work.id).kind, definition.kind);
  assert.equal(writes(), beforeRead);
  const updated = (await service.update(work.id, { revision: 1, action: "update",
    changes: { instruction: "检查更新后的 aide 仓库" } }));
  assert.equal(updated.kind, definition.kind);
  assert.equal(updated.instruction, "检查更新后的 aide 仓库");
  assert.equal(store.resources.get(type, work.id).metadata.uid, uid);
  await assert.rejects(async () => (await service.update(work.id, { revision: 1, action: "pause" })), /revision changed/);
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

test("Work tools validate schedules and answers without corrupting existing work", async (t) => {
  const { store, service } = setup(t);
  await assert.rejects(async () => (await service.create({ ...task, kind: "routine" })), /Routine needs/);
  const work = (await service.create(task));
  assert.throws(() => WorkUpdateSchema.parse({ revision: 1, action: "update", changes: { kind: "routine" } }), /Unrecognized key/);
  await assert.rejects(async () => (await service.update(work.id, { revision: 1, action: "update", changes: { trigger: { cron: "0 9 * * *", timezone: "UTC", event: null } } })), /Task cannot/);
  await assert.rejects(async () => (await service.update(work.id, { revision: 1, action: "answer", note: "aide" })), /waiting/);
  assert.equal(service.read(work.id).revision, 1);
  work.status = "waiting"; work.question = "哪个仓库？"; (await store.save(work));
  const answered = (await service.update(work.id, { revision: 1, action: "answer", note: "aide" }));
  assert.equal(answered.status, "ready");
  assert.equal(answered.question, null);
  assert.equal(answered.history.at(-1)?.text, "aide");
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
  assert.equal(aide.store.read().messages.length, 0);
  assert.equal(aide.store.resources.find(TASK_TYPE, work.id), undefined);
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
