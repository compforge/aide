import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { Aide } from "../plugins/personal/aide.ts";
import type { Outcome, Route } from "../plugins/personal/prompts.ts";
import { nextOccurrence, type Work } from "../plugins/personal/model.ts";

import { fakeOptions, type Agent } from "./fake-harness.ts";
import { SessionStore } from "../src/runtime/store/store.ts";

const log = pino({ level: "silent" });
const done: Outcome = { action: "done", summary: "Checked and finished", notification: "完成了", question: null, nextAt: null };
const create: Route = { action: "create", workId: null, kind: "task", title: "处理待办", instruction: "检查并处理待办", trigger: null, response: "已接下" };

function setup(t: TestContext, agent: Agent) {
  const dir = mkdtempSync(join(tmpdir(), "aide-test-"));
  const path = dir;
  const aide = new Aide(path, fakeOptions(agent, path), log);
  t.after(async () => { await aide.close(); rmSync(dir, { recursive: true, force: true }); });
  aide.start();
  return { aide, path };
}

function input(id = "one", text = "帮我处理待办") { return { id, text, conversationId: "me" }; }

test("Task asks, persists a question across restart, then completes after an answer", async (t) => {
  let id = "";
  let runs = 0;
  const agent: Agent = {
    route: async () => id ? { ...create, action: "answer", workId: id } : create,
    execute: async (work) => {
      if (++runs === 1) return { ...done, action: "ask", question: "使用哪个项目？" };
      assert.ok(work.history.some((entry) => entry.text === "项目 A"));
      return done;
    },
  };
  const { aide, path } = setup(t, agent);
  id = (await aide.receive(input())).workId!;
  await aide.settled();
  assert.equal(aide.store.read().works[0]?.status, "waiting");
  await aide.close();
  const restarted = new Aide(path, fakeOptions(agent, path), log);
  t.after(() => restarted.close());
  restarted.start();
  assert.equal(restarted.store.read().works[0]?.question, "使用哪个项目？");
  await restarted.receive(input("two", "项目 A"));
  await restarted.settled();
  assert.equal(restarted.store.read().works[0]?.status, "done");
  assert.equal(runs, 2);
});

test("duplicate inbound delivery creates and executes a Task once", async (t) => {
  let routes = 0;
  let runs = 0;
  const { aide } = setup(t, {
    route: async () => { routes++; return create; }, execute: async () => { runs++; return done; },
  });
  const responses = await Promise.all([aide.receive(input()), aide.receive(input())]);
  await aide.settled();
  assert.equal(responses[0]?.id, responses[1]?.id);
  assert.equal(aide.store.read().works.length, 1);
  assert.equal(routes, 1);
  assert.equal(runs, 1);
});

test("Routine can be triggered by event, deduplicates deliveries, and stays active", async (t) => {
  let runs = 0;
  const { aide } = setup(t, {
    route: async () => ({ ...create, kind: "routine", trigger: { cron: null, timezone: "UTC", event: "docs.changed" } }),
    execute: async () => { runs++; return { ...done, notification: null }; },
  });
  await aide.receive(input());
  await aide.settled();
  assert.equal(runs, 0);
  const event = { id: "event-1", conversationId: "me", name: "docs.changed", text: "new document" };
  assert.equal(aide.event(event), 1);
  assert.equal(aide.event(event), 0);
  await aide.settled();
  assert.equal(runs, 1);
  assert.equal(aide.store.read().works[0]?.status, "scheduled");
  assert.equal(aide.store.read().messages.filter((m) => m.role === "aide").length, 1);
});

test("a Task can become a Routine without losing identity and history", async (t) => {
  let id = "";
  const { aide } = setup(t, {
    route: async () => id ? { ...create, action: "update", workId: id, kind: "routine",
      trigger: { cron: "0 9 * * *", timezone: "Asia/Shanghai", event: null } } : create,
    execute: async () => done,
  });
  id = (await aide.receive(input())).workId!;
  await aide.settled();
  await aide.receive(input("two", "以后每天都做"));
  const work = aide.store.read().works[0]!;
  assert.equal(work.id, id);
  assert.equal(work.kind, "routine");
  assert.equal(work.status, "scheduled");
  assert.ok(work.history.some((entry) => entry.text === done.summary));
  assert.ok(work.nextAt);
});

test("overdue work is woken after restart, without replaying missed occurrences", async (t) => {
  let runs = 0;
  const { aide, path } = setup(t, {
    route: async () => ({ ...create, kind: "routine", trigger: { cron: "0 9 * * *", timezone: "UTC", event: null } }),
    execute: async () => done,
  });
  await aide.receive(input());
  await aide.close();
  aide.store.save({ ...aide.store.read().works[0]!, nextAt: "2000-01-01T00:00:00Z" });
  const restarted = new Aide(path, fakeOptions({ route: async () => create, execute: async () => { runs++; return done; } }, path), log);
  t.after(() => restarted.close());
  restarted.start();
  await new Promise((resolve) => setTimeout(resolve, 25));
  await restarted.settled();
  assert.equal(runs, 1);
  assert.ok(Date.parse(restarted.store.read().works[0]!.nextAt!) > Date.now());
});

test("interrupted and failed executions become uncertain and are not auto-replayed", async (t) => {
  let runs = 0;
  const agent: Agent = { route: async () => create, execute: async () => { runs++; throw new Error("CLI disconnected"); } };
  const { aide, path } = setup(t, agent);
  await aide.receive(input());
  await aide.settled();
  assert.equal(aide.store.read().works[0]?.status, "uncertain");
  await aide.close();
  aide.store.save({ ...aide.store.read().works[0]!, status: "running" });
  const restarted = new Aide(path, fakeOptions(agent, path), log);
  t.after(() => restarted.close());
  restarted.start();
  await restarted.settled();
  assert.equal(restarted.store.read().works[0]?.status, "uncertain");
  assert.equal(runs, 1);
});

test("a pause arriving during execution survives its eventual result", async (t) => {
  let finish!: (outcome: Outcome) => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let id = "";
  const { aide } = setup(t, {
    route: async () => id ? { ...create, action: "pause", workId: id } : create,
    execute: async () => { started(); return new Promise((resolve) => { finish = resolve; }); },
  });
  id = (await aide.receive(input())).workId!;
  await running;
  await aide.receive(input("pause", "暂停"));
  finish(done);
  await aide.settled();
  assert.equal(aide.store.read().works[0]?.status, "paused");
});

test("an update during execution is reconciled using the latest instruction", async (t) => {
  let finish!: (outcome: Outcome) => void;
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let id = "";
  const seen: Work[] = [];
  const { aide } = setup(t, {
    route: async () => id ? { ...create, action: "update", workId: id, instruction: "处理新目标" } : create,
    execute: async (work) => {
      seen.push(work); started();
      return seen.length === 1 ? new Promise((resolve) => { finish = resolve; }) : done;
    },
  });
  id = (await aide.receive(input())).workId!;
  await running;
  await aide.receive(input("update", "换成新目标"));
  finish(done);
  await aide.settled();
  assert.equal(seen.length, 2);
  assert.equal(seen[1]?.instruction, "处理新目标");
  assert.ok(seen[1]?.history.some((entry) => entry.text === done.summary));
});

test("router cannot attach work from a different conversation", async (t) => {
  let id = "";
  const { aide } = setup(t, {
    route: async () => id ? { ...create, action: "resume", workId: id } : create,
    execute: async () => done,
  });
  id = (await aide.receive(input())).workId!;
  await aide.settled();
  await assert.rejects(aide.receive({ ...input("two"), conversationId: "other" }), /Unknown work/);
  assert.equal(aide.store.read().works[0]?.status, "done");
});

test("cron schedules use the specified timezone", () => {
  assert.equal(nextOccurrence({ cron: "0 9 * * *", timezone: "Asia/Shanghai", event: null },
    new Date("2026-10-16T00:00:00Z")), "2026-10-16T01:00:00.000Z");
});

test("personal Worker crash cancels its invocation and preserves uncertain work across restart", async (t) => {
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  let runs = 0;
  const agent: Agent = { route: async () => create, execute: async () => {
    runs++; started(); return new Promise(() => {});
  } };
  const { aide, path } = setup(t, agent);
  await aide.receive(input());
  await running;
  const sessions = new SessionStore(path);
  const session = sessions.openSession(sessions.listSessions()[0]!.aideSessionId);
  let pid = 0;
  for (let attempt = 0; attempt < 100 && !pid; attempt++) {
    const lines = readFileSync(join(session.dir, "session.log"), "utf8").trim().split("\n");
    pid = lines.map((line) => JSON.parse(line)).find((entry) => entry.message === "Personal Plugin worker activated")?.attributes?.pid ?? 0;
    if (!pid) await Bun.sleep(10);
  }
  assert.ok(pid && pid !== process.pid);
  process.kill(pid, "SIGKILL");
  for (let attempt = 0; attempt < 200 && aide.plugins.isInstanceActive("personal"); attempt++) await Bun.sleep(10);
  assert.equal(aide.plugins.isInstanceActive("personal"), false);
  assert.equal(aide.store.read().works[0]?.status, "uncertain");
  assert.ok(aide.plugins.listHarnessInvocations().some((invocation) => invocation.phase === "cancelled" || invocation.phase === "failed"));
  await aide.close();
  const restarted = new Aide(path, fakeOptions(agent, path), log);
  t.after(() => restarted.close());
  await restarted.start(); await restarted.settled();
  assert.equal(restarted.store.read().works[0]?.status, "uncertain");
  assert.equal(runs, 1);
});
