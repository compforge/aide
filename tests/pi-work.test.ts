import { ConversationStore } from "../src/host/conversation/store.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { Aide } from "../plugins/personal/aide.ts";
import { Store, message } from "../plugins/personal/store.ts";
import { WorkService, type WorkDefinition } from "../plugins/personal/work.ts";
import { WORK_TYPE } from "../plugins/personal/resources.ts";
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
  const store = new Store(new PluginResourceStore({ session, pluginInstanceId: "personal" }), () => writes++, new ConversationStore(session));
  return { store, service: new WorkService(store, "me", log), writes: () => writes };
}

test("Work CRUD preserves identity, enforces revisions and conversation scope, and archives delivery on deletion", (t) => {
  const { store, service, writes } = setup(t);
  const work = service.create(task);
  const uid = store.resources.get(WORK_TYPE, work.id).metadata.uid;
  const response = message("me", "已接下", work.id);
  store.save(work, [response], "accepted-input");
  assert.equal(service.list().length, 1);
  const beforeRead = writes();
  assert.equal(service.read(work.id).status, "ready");
  assert.equal(writes(), beforeRead);
  const updated = service.update(work.id, { revision: 1, action: "update",
    changes: { kind: "routine", trigger: { cron: "0 9 * * *", timezone: "UTC", event: null } } });
  assert.equal(updated.kind, "routine");
  assert.equal(updated.status, "scheduled");
  assert.equal(store.resources.get(WORK_TYPE, work.id).metadata.uid, uid);
  assert.throws(() => service.update(work.id, { revision: 1, action: "pause" }), /revision changed/);
  assert.throws(() => service.delete(work.id, 1), /revision changed/);
  const other = new WorkService(store, "other", log);
  assert.deepEqual(other.list(), []);
  assert.throws(() => other.read(work.id), /Unknown work/);
  assert.throws(() => other.delete(work.id, updated.revision), /Unknown work/);
  service.delete(work.id, updated.revision);
  assert.deepEqual(service.list(), []);
  assert.equal(store.response("accepted-input")?.id, response.id);
  assert.equal(store.read().messages.filter((item) => item.id === response.id).length, 1);
});

test("Work tools validate schedules and answers without corrupting existing work", (t) => {
  const { store, service } = setup(t);
  assert.throws(() => service.create({ ...task, kind: "routine" }), /Routine needs/);
  const work = service.create(task);
  assert.throws(() => service.update(work.id, { revision: 1, action: "update", changes: { kind: "routine" } }), /Routine needs/);
  assert.throws(() => service.update(work.id, { revision: 1, action: "answer", note: "aide" }), /waiting/);
  assert.equal(service.read(work.id).revision, 1);
  work.status = "waiting"; work.question = "哪个仓库？"; store.save(work);
  const answered = service.update(work.id, { revision: 1, action: "answer", note: "aide" });
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
  const work = tools.create(task);
  await running;
  assert.equal(tools.read(work.id).status, "running");
  tools.delete(work.id, work.revision);
  release(); await aide.settled();
  assert.deepEqual(tools.list(), []);
  assert.equal(aide.store.read().messages.length, 0);
  assert.equal(aide.store.resources.find(WORK_TYPE, work.id), undefined);
});
