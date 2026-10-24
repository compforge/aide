import { fixtureAddress, fixtureIncoming } from "./address-fixture.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { httpChannel } from "../src/api/index.ts";
import { topicView } from "../src/channel/view.ts";
import { seedInput } from "./topic-fixture.ts";
import { fakeOptions } from "./fake-harness.ts";

const log = pino({ level: "silent" });
async function listen(aide: Aide) {
  const server = httpChannel(aide, log);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const remove = (topicId: string, revision: number, extra = {}) => fetch(base + "/topics/delete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ topicId, revision, uid: aide.topics.resource(topicId)?.metadata.uid ?? "missing", ...extra }),
  });
  return { server, base, remove };
}

/** @case Deleting one Topic preserves other contexts and shared Input facts, including after restart. */
test("Web deletes a revision-checked Topic and preserves shared Input and sibling topics", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-delete-topic-"));
  const options = fakeOptions({ execute: async () => { throw new Error("No work expected"); } }, dir);
  let aide = new Aide(dir, options, log);
  const scope = aide.personal;
  await seedInput(scope.topics, "shared-input", { topicId: "a", origin: "source", originId: "personal.environments", text: "共同观察" }, { phase: "done" });
  await seedInput(scope.topics, "shared-input", { topicId: "b", origin: "source", originId: "personal.environments", text: "共同观察" }, { phase: "done" });
  await scope.topics.archive("a", [{ id: "old", topicId: "a", text: "只属于 a", workId: null, target: fixtureAddress("a") }]);
  await aide.start(); await aide.settled();
  const { server, base, remove } = await listen(aide);
  t.after(async () => { server.closeAllConnections(); server.close(); await aide.close(); rmSync(dir, { recursive: true, force: true }); });
  const revision = scope.topics.get("a")!.revision;
  assert.equal((await remove("missing", 1)).status, 404);
  assert.equal((await remove("a", 0)).status, 400);
  assert.equal((await remove("a", revision, { sessionId: "other" })).status, 400);
  assert.equal((await fetch(base + "/topics/delete", { method: "POST", headers: { origin: "https://unrelated.example", "content-type": "application/json" }, body: JSON.stringify({ topicId: "a", revision }) })).status, 403);
  await aide.setTopicTrigger("a", true); await aide.settled();
  assert.equal((await remove("a", revision)).status, 409);
  const currentRevision = scope.topics.get("a")!.revision;
  assert.equal((await remove("a", currentRevision)).status, 200);
  assert.equal((await remove("a", currentRevision)).status, 404);
  assert.deepEqual((await (await fetch(base + "/topics")).json() as { id: string }[]).map((c) => c.id), ["b"]);
  assert.equal(scope.topics.inputStore.get("shared-input")?.spec.text, "共同观察");
  assert.equal(scope.topics.input("shared-input", "b")?.consumption.phase, "done");
  assert.deepEqual(topicView(aide, "a").blocks, []);
  await aide.settled(); await aide.close();
  aide = new Aide(dir, options, log); await aide.start(); await aide.settled();
  assert.deepEqual(aide.topicIds(), ["b"]);
  assert.equal(aide.outputs().some((m) => m.id === "old"), true);
});

test("Topic deletion rejects queued and running and associated Work without changing them", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-delete-busy-"));
  const aide = new Aide(dir, fakeOptions({ execute: async () => { throw new Error("No execution expected"); } }, dir), log);
  const scope = aide.personal;
  for (const phase of [undefined, "running"] as const) {
    const id = phase ?? "queued";
    await seedInput(scope.topics, id, { topicId: id, origin: "channel", originId: "web", text: id }, phase ? { phase } : {});
  }
  const task = await aide.work("task-owner").create({ kind: "task", title: "保留事项", instruction: "check", trigger: null });
  const routine = await aide.work("routine-owner").create({ kind: "routine", title: "保留安排", instruction: "check", trigger: { cron: null, timezone: "UTC", event: "changed" } });
  const { server, remove } = await listen(aide);
  t.after(async () => { server.closeAllConnections(); server.close(); await aide.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const id of ["queued", "running", "task-owner", "routine-owner"]) {
    const before = aide.personal.topics.get(id)!;
    const response = await remove(id, before.revision);
    assert.equal(response.status, 409);
    assert.match((await response.json() as { error: string }).error, id.endsWith("owner") ? /事项或安排/ : /待处理/);
    assert.deepEqual(aide.personal.topics.get(id), before);
  }
  assert.deepEqual(aide.works().map((w) => w.id).sort(), [task.id, routine.id].sort());
});

/** @case Reusing a Channel after deletion creates fresh native context and cannot replay old accepted messages. */
test("Recreated Topic has fresh execution context and no old outputs or progress", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "aide-recreate-topic-"));
  let aide: Aide;
  let calls = 0;
  aide = new Aide(dir, fakeOptions({ chief: async () => {
    return ++calls === 1 ? "旧答案" : "新答案";
  }, execute: async () => ({ action: "done", summary: "旧工作完成", recent: "旧工作完成", notification: "旧工作回复", question: null, nextAt: null }) }, dir), log);
  const { server, remove } = await listen(aide);
  t.after(async () => { server.closeAllConnections(); server.close(); await aide.close(); rmSync(dir, { recursive: true, force: true }); });
  await aide.receive(fixtureIncoming({ channelId: "web", id: "old", topicId: "me", text: "旧请求" }));
  await aide.settled();
  const work = await aide.work("me").create({ kind: "task", title: "旧工作", instruction: "执行一次", trigger: null });
  await aide.settled();
  await aide.work("me").delete(work.id, aide.works().find((item) => item.id === work.id)!.revision);
  await aide.settled();
  assert.ok(aide.outputs().some((m) => m.text === "旧工作回复"));
  const oldResource = aide.personal.topics.resource("me")!;
  const oldLanes = aide.invocations().map((i) => i.runtimeId);
  assert.equal((await remove("me", Number(oldResource.metadata.resourceVersion))).status, 200);
  assert.ok(aide.outputs().some((o) => o.topicUid === oldResource.metadata.uid));
  assert.deepEqual(topicView(aide, "me").blocks, []);
  await aide.settled();
  await aide.receive(fixtureIncoming({ channelId: "web", id: "new", topicId: "me", text: "新请求" })); await aide.settled();
  const current = aide.personal.topics.resource("me")!;
  assert.notEqual(current.metadata.uid, oldResource.metadata.uid);
  assert.equal((await remove("me", Number(current.metadata.resourceVersion), { uid: oldResource.metadata.uid })).status, 409);
  const invocation = aide.invocations().at(-1)!;
  assert.equal(oldLanes.includes(invocation.runtimeId), false);
  const view = topicView(aide, "me");
  assert.ok(view.blocks.some((b) => b.content.includes("新答案")));
  assert.equal(view.blocks.some((b) => /旧答案|旧请求|旧工作|继续吗/.test(b.content)), false);
  assert.equal(view.blocks.filter((b) => b.type === "execution").length, 1);
  await aide.receive(fixtureIncoming({ channelId: "web", id: "old", topicId: "me", text: "旧请求" })); await aide.settled();
  assert.equal(calls, 2);
  assert.equal(aide.outputs().some((m) => m.text === "旧请求"), false);
});
