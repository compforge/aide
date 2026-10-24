import { fixtureAddress } from "./address-fixture.ts";
import { fixtureIncoming } from "./address-fixture.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { Aide } from "../src/app.ts";
import type { Outcome } from "./fake-harness.ts";
import { nextOccurrence, type Work } from "../plugins/personal/model.ts";

import { fakeOptions, type Agent } from "./fake-harness.ts";
import { HarnessFixtures } from "./harness-fixture.ts";

const log = pino({ level: "silent" });
const done: Outcome = { action: "done", summary: "Checked and finished", recent: "Checked and finished", notification: "完成了", question: null, nextAt: null };
const routine = { kind: "routine" as const, title: "处理待办", instruction: "检查并处理待办", trigger: { cron: null, timezone: "UTC", event: "start" } };
const task = { kind: "task" as const, title: "处理待办", instruction: "检查并处理待办", trigger: null };

async function setup(t: TestContext, agent: Agent) {
  const dir = mkdtempSync(join(tmpdir(), "aide-test-"));
  const path = dir;
  const aide = new Aide(path, fakeOptions(agent, path), log);
  t.after(async () => { await aide.close(); rmSync(dir, { recursive: true, force: true }); });
  await aide.personal.topics.ensure("me", fixtureAddress("me"));
  await aide.start();
  return { aide, path };
}


test("Routine end_turn without a tool report stays uncertain across restart and never replays", async t => {
  let runs = 0;
  const agent: Agent = { complete: false, execute: async () => { runs++; return done; } };
  const { aide, path } = await setup(t, agent);
  const work = await aide.work("me").create(routine);
  await aide.event({ id: "first",  topicId: "me", name: "start", text: "start" });
  await aide.settled();
  assert.equal(aide.work("me").read(work.id).status, "uncertain");
  const input = aide.topics.inputStore.query("handlePending", work.uid!)[0]!;
  assert.match(input.status.handle![work.uid!]!.lastError!, /without confirming/);
  assert.equal(aide.outputs().length, 0);
  await aide.close();
  const restarted = new Aide(path, fakeOptions(agent, path), log);
  t.after(() => restarted.close());
  await restarted.start(); await restarted.settled();
  assert.equal(restarted.work("me").read(work.id).status, "uncertain");
  assert.equal(runs, 1);
});

for (const definition of [task, { ...task, kind: "routine" as const, trigger: { cron: null, timezone: "UTC", event: "start" } }])
test(`${definition.kind} asks, persists a question across restart, then records completion after an answer`, async (t) => {
  let id = "";
  let runs = 0;
  const agent: Agent = {
    execute: async (work) => {
      if (++runs === 1) return { ...done, action: "ask", question: "使用哪个项目？" };
      assert.ok(work.recent.some((entry) => entry.text.includes("项目 A")));
      return done;
    },
  };
  const { aide, path } = await setup(t, agent);
  id = (await aide.work("me").create(definition)).id;
  if (definition.kind === "routine") (await aide.event({ id: "first",  topicId: "me", name: "start", text: "start" }));
  await aide.settled();
  assert.equal(aide.works()[0]?.status, "waiting");
  await aide.close();
  const restarted = new Aide(path, fakeOptions(agent, path), log);
  t.after(() => restarted.close());
  restarted.start();
  assert.equal(restarted.works()[0]?.question, "使用哪个项目？");
  await restarted.start();
  (await restarted.work("me").requestInput(id, { action: "answer", text: "项目 A" }));
  await restarted.settled();
  assert.equal(restarted.works()[0]?.status, definition.kind === "task" ? "done" : "scheduled");
  assert.equal(runs, 2);
});

test("Routine business completion depends on its tool report, independently of final text", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-missing-final-"));
  let executed = false;
  const options = fakeOptions({ execute: async () => { executed = true; return done; } }, dir);
  const aide = new Aide(dir, { ...options, createAdapter: (target) => {
    const adapter = options.createAdapter(target);
    const open = adapter.create.bind(adapter);
    adapter.create = (config, sink, binding) => open(config, (event) => {
      if (executed && event.kind === "agent_message") {
        sink({ ...event, payload: { ...event.payload, phase: undefined } });
      } else sink(event);
    }, binding);
    return adapter;
  } }, log);
  t.after(async () => { await aide.close(); rmSync(dir, { recursive: true, force: true }); });
  await aide.personal.topics.ensure("me", fixtureAddress("me"));
  await aide.start(); await aide.work("me").create(routine);
  await aide.event({ id: "first",  topicId: "me", name: "start", text: "start" }); await aide.settled();
  assert.equal(aide.works()[0]!.status, "scheduled");
  assert.equal(aide.works()[0]!.summary, done.summary);
});

test("Routine can be triggered by event, deduplicates deliveries, and stays active", async (t) => {
  let runs = 0;
  const { aide } = await setup(t, {
    execute: async () => { runs++; return { ...done, notification: null }; },
  });
  (await aide.work("me").create({ ...task, kind: "routine", trigger: { cron: null, timezone: "UTC", event: "docs.changed" } }));
  await aide.settled();
  assert.equal(runs, 0);
  const event = { id: "event-1",  topicId: "me", name: "docs.changed", text: "new document" };
  assert.equal((await aide.event(event)), 1);
  assert.equal((await aide.event(event)), 0);
  await aide.settled();
  assert.equal(runs, 1);
  assert.equal(aide.works()[0]?.status, "scheduled");
  assert.equal(aide.outputs().filter((m) => m.role === "aide").length, 0);
});

test("replacing a Task with a Routine uses distinct identities and retains the completed Task's messages", async (t) => {
  const { aide } = await setup(t, { execute: async () => done });
  const tools = aide.work("me");
  const original = (await tools.create(task));
  await aide.settled();
  const prior = tools.read(original.id);
  const routine = (await tools.create({ kind: "routine", title: prior.title,
    instruction: `${prior.instruction}\nPrevious result: ${prior.recent.at(-1)!.text}`,
    trigger: { cron: null, timezone: "UTC", event: "check.again" } }));
  (await tools.delete(original.id, prior.revision));
  await aide.settled();
  assert.notEqual(routine.id, original.id);
  assert.deepEqual(tools.list().map((work) => work.id), [routine.id]);
  assert.ok(aide.outputs().some((item) => item.workId === original.id && item.text === done.notification));
  assert.equal((await aide.event({ id: "next",  topicId: "me", name: "check.again", text: "检查更新" })), 1);
  await aide.settled();
  assert.equal(tools.read(routine.id).status, "scheduled");
  assert.ok(aide.outputs().some((item) => item.workId === routine.id && item.text === done.notification));
});

test("overdue work is woken after restart, without replaying missed occurrences", async (t) => {
  let runs = 0;
  const { aide, path } = await setup(t, {
    execute: async () => done,
  });
  (await aide.work("me").create({ ...task, kind: "routine", trigger: { cron: "0 9 * * *", timezone: "UTC", event: null } }));
  await aide.close();
  (await aide.personal.store.save({ ...aide.works()[0]!, nextAt: "2000-01-01T00:00:00Z" }));
  const restarted = new Aide(path, fakeOptions({ execute: async () => { runs++; return done; } }, path), log);
  t.after(() => restarted.close());
  restarted.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await restarted.settled();
  assert.equal(runs, 1);
  assert.ok(Date.parse(restarted.works()[0]!.nextAt!) > Date.now());
});

test("interrupted and failed executions become uncertain and are not auto-replayed", async (t) => {
  let runs = 0;
  const agent: Agent = { execute: async () => { runs++; throw new Error("CLI disconnected"); } };
  const { aide, path } = await setup(t, agent);
  (await aide.work("me").create(task));
  await aide.settled();
  assert.equal(aide.works()[0]?.status, "uncertain");
  await aide.close();
  (await aide.personal.store.save({ ...aide.works()[0]!, status: "running" }));
  const restarted = new Aide(path, fakeOptions(agent, path), log);
  t.after(() => restarted.close());
  restarted.start();
  await restarted.settled();
  assert.equal(restarted.works()[0]?.status, "uncertain");
  assert.equal(runs, 1);
});

test("a pause arriving during execution survives its eventual result", async (t) => {
  let finish!: (outcome: Outcome) => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let id = "";
  const { aide } = await setup(t, {
    execute: async () => { started(); return new Promise((resolve) => { finish = resolve; }); },
  });
  id = (await aide.work("me").create(task)).id;
  await running;
  (await aide.work("me").requestInput(id, { action: "pause", text: "暂停" }));
  finish(done);
  await aide.settled();
  assert.equal(aide.works()[0]?.status, "paused");
});

test("an update during execution is reconciled using the latest instruction", async (t) => {
  let finish!: (outcome: Outcome) => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let id = "";
  const seen: Work[] = [];
  const { aide } = await setup(t, {
    execute: async (work) => {
      seen.push(work); started();
      return seen.length === 1 ? new Promise((resolve) => { finish = resolve; }) : done;
    },
  });
  id = (await aide.work("me").create(task)).id;
  await running;
  (await aide.work("me").requestInput(id, { action: "update", text: "处理新目标", changes: { instruction: "处理新目标" } }));
  finish(done);
  await aide.settled();
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.instruction, "处理新目标");
  assert.ok(seen[1]?.recent.some((entry) => entry.text === done.summary));
});

test("cron schedules use the specified timezone", () => {
  assert.equal(nextOccurrence({ cron: "0 9 * * *", timezone: "Asia/Shanghai", event: null },
    new Date("2026-10-16T00:00:00Z")), "2026-10-16T01:00:00.000Z");
});

test("personal Worker crash cancels its invocation and preserves uncertain work across restart", async (t) => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let runs = 0;
  const agent: Agent = { execute: async () => {
    runs++; started(); return new Promise(() => {});
  } };
  const { aide, path } = await setup(t, agent);
  (await aide.work("me").create(task));
  await running;
  let pid = 0;
  for (let attempt = 0; attempt < 100 && !pid; attempt++) {
    const lines = readFileSync(join(path, "runtime.log"), "utf8").trim().split("\n");
    pid = lines.map((line) => JSON.parse(line)).find((entry) => entry.message === "Personal Plugin worker activated")?.attributes?.pid ?? 0;
    if (!pid) await Bun.sleep(10);
  }
  assert.ok(pid && pid !== process.pid);
  process.kill(pid, "SIGKILL");
  for (let attempt = 0; attempt < 200 && aide.personal.plugins.isInstanceActive("personal"); attempt++) await Bun.sleep(10);
  assert.equal(aide.personal.plugins.isInstanceActive("personal"), false);
  assert.equal(aide.works()[0]?.status, "uncertain");
  assert.ok(aide.invocations().some((invocation) => invocation.phase === "cancelled" || invocation.phase === "failed"));
  await aide.close();
  const restarted = new Aide(path, fakeOptions(agent, path), log);
  t.after(() => restarted.close());
  await restarted.start(); await restarted.settled();
  assert.equal(restarted.works()[0]?.status, "uncertain");
  assert.equal(runs, 1);
});


for (const definition of [task, { ...task, kind: "routine" as const, trigger: { cron: null, timezone: "UTC", event: "start" } }])
test(`${definition.kind} requeues a dynamic wait and applies its own completion rule`, async (t) => {
  let runs = 0;
  const { aide } = await setup(t, { execute: async () => ++runs === 1
    ? { ...done, action: "wait", nextAt: new Date(Date.now() + 200).toISOString() } : done });
  const work = (await aide.work("me").create(definition));
  if (definition.kind === "routine") (await aide.event({ id: "first",  topicId: "me", name: "start", text: "start" }));
  const expected = definition.kind === "task" ? "done" : "scheduled";
  // Timer-triggered reconciles are owned by Manager, not Aide's explicit wake promises.
  for (let attempt = 0; attempt < 200; attempt++) {
    const current = aide.work("me").read(work.id);
    if (runs === 2 && current.status === expected && current.recent.length === 2) break;
    await Bun.sleep(10);
  }
  assert.equal(runs, 2);
  assert.equal(aide.work("me").read(work.id).status, definition.kind === "task" ? "done" : "scheduled");
  assert.equal(aide.work("me").read(work.id).nextAt, null);
});

// @case restart_new_cwd: changing execution cwd preserves personal work and topic state.
test("Aide resumes the same Session and personal state when execution cwd changes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-cwd-restart-"));
  const agent: Agent = { chief: async () => "记住了", execute: async () => { throw new Error("Unexpected execution"); } };
  const first = new Aide(root, fakeOptions(agent, join(root, "code-a"), [], root), log);
  let restarted: Aide | undefined;
  t.after(async () => { await first.close(); await restarted?.close(); rmSync(root, { recursive: true, force: true }); });
  await first.receive(fixtureIncoming({ channelId: "web", id: "hello",  topicId: "me", text: "你好" }));
  await first.settled();
  const routine = await first.work("me").create({ ...task, kind: "routine", trigger: { cron: null, timezone: "UTC", event: "manual" } });
  const messages = first.outputs();
  await first.close();

  const executionCwds: string[] = [];
  const options = fakeOptions(agent, join(root, "code-b"), [], root);
  restarted = new Aide(root, { ...options, createAdapter: (target) => {
    const adapter = options.createAdapter(target);
    const open = adapter.create.bind(adapter);
    adapter.create = (config, sink, binding) => {
      executionCwds.push(config.cwd);
      return open(config, sink, binding);
    };
    return adapter;
  } }, log);
  await restarted.start(); await restarted.settled();
  assert.equal(restarted.work("me").read(routine.id).title, routine.title);
  assert.deepEqual(restarted.outputs(), messages);
  await restarted.receive(fixtureIncoming({ channelId: "web", id: "again",  topicId: "me", text: "继续聊" }));
  await restarted.settled();
  assert.ok(executionCwds.length > 0);
  assert.ok(executionCwds.every((cwd) => cwd === join(root, "code-b")));
});


test("Task uses its dedicated agent without an Aide execution store", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-default-pi-"));
  const seen: string[] = [];
  const options = fakeOptions({ execute: async () => done }, root);
  const aide = new Aide(root, { ...options, createAdapter: (target) => {
    seen.push(target.harness);
    return options.createAdapter(target);
  } }, log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.personal.topics.ensure("me", fixtureAddress("me"));
  await aide.start();
  await aide.work("me").create(task); await aide.settled();
  assert.equal(aide.works()[0]!.status, "done");
  assert.deepEqual(seen, ["task"]);
});


for (const harness of ["pi", "codex", "claude", "dsh"] as const)
test(`Task, Routine and Chief remain dedicated agents with default Harness ${harness}`, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-execution-target-"));
  const seen: string[] = [];
  const options = fakeOptions({ chief: async () => "hello", execute: async () => done }, root);
  const defaultHarnessConfig = { id: "chosen", harness, model: "configured-model" };
  const aide = new Aide(root, { ...options, defaultHarnessConfig, createAdapter: (target) => {
    seen.push(`${target.id}:${target.harness}`); return options.createAdapter(target);
  } }, log);
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  aide.personal;

  await aide.receive(fixtureIncoming({ channelId: "web", id: "hello",  topicId: "me", text: "hello" }));
  await aide.settled();
  // Mutating the caller's object cannot change future Sessions' startup target.
  defaultHarnessConfig.model = "changed-after-startup";
  aide.personal;
  assert.equal(aide.runtime.harnesses.find(target => target.id === "chosen")!.model, "configured-model");
  await aide.work("me").create(task); await aide.settled();
  await aide.work("me").create({ ...task, kind: "routine", trigger: { cron: null, timezone: "UTC", event: "sample" } });
  await aide.event({ id: "sample",  topicId: "me", name: "sample", text: "sample" });
  await aide.settled();
  assert.equal(aide.works().find((work) => work.kind === "task")!.status, "done");
  assert.equal(aide.works().find((work) => work.kind === "routine")!.status, "scheduled");
  assert.ok(seen.some((item) => item.endsWith(":chief")));
  assert.equal(seen.filter((item) => item === `chosen:${harness}`).length, 0);
  assert.equal(seen.filter((item) => item === "routine:routine").length, 1);
  assert.equal(seen.filter((item) => item === "task:task").length, 1);
  assert.equal(aide.runtime.harnesses.find(target => target.id === "chosen")!.harness, harness);
});

test("Routine event Input deduplication survives Input collection and restart", async t => {
  const { aide, path } = await setup(t, { execute: async () => done });
  await aide.work("me").create({ ...task, kind: "routine", trigger: { cron: null, timezone: "UTC", event: "sample" } });
  const event = { id: "same-event",  topicId: "me", name: "sample", text: "sample evidence" };
  assert.equal(await aide.event(event), 1);
  await aide.settled();
  const store = aide.topics.inputStore;
  const fact = store.list().find(input => input.spec.originId === "personal.events")!;
  assert.ok(Object.values(fact.status.handle!).every(receipt => receipt.completedAt));
  store.storage.configure({ kinds: { "aide.dev/Input": { maxCount: 1 } } } as Parameters<typeof store.storage.configure>[0]);
  store.submit("unrouted", "eviction-pressure", { origin: "source", originId: "test", text: "new fact" }, {
    route: { completedAt: new Date().toISOString(), result: { topics: [], reason: "test" } },
  });
  assert.equal(store.get(fact.metadata.name), undefined);
  const invocations = aide.invocations().length;
  assert.equal(await aide.event(event), 0);
  await aide.settled();
  assert.equal(aide.invocations().length, invocations);
  await aide.close();
  const restarted = new Aide(path, fakeOptions({ execute: async () => { throw new Error("Must not replay event"); } }, path), log);
  t.after(() => restarted.close());
  await restarted.start();
  assert.equal(await restarted.event(event), 0);
  await restarted.settled();
  assert.equal(restarted.works()[0]!.status, "scheduled");
});
