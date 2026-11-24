import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { httpChannel } from "../src/api/index.ts";
import { fakeOptions } from "./fake-harness.ts";
import { fixtureAddress } from "./address-fixture.ts";
import { upsertOngoing } from "../plugins/personal/ongoing/service.ts";
import type { TopicWork, TopicListView } from "../src/api/types.ts";
import { TOPIC_TYPE } from "../plugins/personal/topic/model.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";

/** @case Work polling, deletion checks and Routine events never read Output history; Web Work lists stay within the current Topic UID. */
test("Work queries use Topic indexes without materializing Outputs", async t => {
  const dir = mkdtempSync(join(tmpdir(), "aide-work-query-"));
  const log = pino({ level: "silent" });
  const aide = new Aide(dir, fakeOptions({ execute: async () => { throw new Error("Unexpected inference"); } }, dir), log);
  const server = httpChannel(aide, log);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await aide.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await aide.topics.ensure("selected", fixtureAddress("selected"));
  const task = await aide.work("selected").create({ kind: "task", title: "Task", instruction: "check", trigger: null });
  const routineDefinition = { kind: "routine" as const, title: "Routine", instruction: "check", trigger: { cron: null, timezone: "UTC", event: "changed" } };
  const routine = await aide.work("selected").create(routineDefinition);
  const childWork = await aide.work("child").create(routineDefinition);
  const other = await aide.work("other").create(routineDefinition);
  await aide.topics.ensure("empty");
  const selected = aide.topics.resource("selected")!;
  const child = aide.topics.resource("child")!;
  aide.topics.resources.replace(TOPIC_TYPE, child.metadata.name, { ...child.spec, parentRef: resourceRef(selected) }, child.status);
  const client = aide.runtime.plugins.resourceClient("personal");
  const actor = await client.patchStatus(selected, { execution: { id: "web-fixture", startedAt: new Date().toISOString() } });
  const open = await upsertOngoing(client, actor, { title: "Approval", question: "Has it been approved?", progress: "Submitted" }, "open");
  const previous = await upsertOngoing(client, actor, { title: "Release" }, "previous");
  const closed = await upsertOngoing(client, actor, { ongoingId: previous.id, version: previous.version, outcome: "Shipped" }, "close");
  const otherActor = await client.patchStatus(aide.topics.resource("other")!, { execution: { id: "other-chief", startedAt: new Date().toISOString() } });
  await upsertOngoing(client, otherActor, { title: "Other domain" }, "other");
  await aide.personal.store.save(routine, [{ id: "reply", topicId: "selected", text: "Retained reply", workId: routine.id }]);
  aide.start = async () => {};
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const topics: TopicListView = await (await fetch(base + "/topics")).json();
  assert.equal(topics.items.find(t => t.id === "selected")?.ongoingCount, 2);
  assert.equal(topics.items.find(t => t.id === "other")?.ongoingCount, 1);
  aide.topics.outputs = () => { throw new Error("Work query read Output history"); };
  aide.topics.outputStore.streams.reader = () => { throw new Error("Work query opened an Output Stream"); };
  assert.deepEqual(aide.works().map(w => w.id).sort(), [task.id, routine.id, childWork.id, other.id].sort(), "Global Work callers remain supported without Outputs");

  const resources = aide.personal.store.resources;
  const list = resources.list.bind(resources);
  const queriedTopics: string[] = [];
  resources.list = (type, options = {}) => {
    if (type.kind === "Task" || type.kind === "Routine" || type.kind === "Ongoing") {
      assert.equal(options.matchIndex?.name, "topic", "Work resources must be selected before decoding");
      queriedTopics.push(options.matchIndex!.value);
    }
    return list(type, options);
  };
  const response = await fetch(base + "/work?topicId=selected");
  assert.equal(response.status, 200);
  const items: TopicWork[] = await response.json();
  assert.deepEqual(items.map(w => w.id).sort(), [task.id, routine.id, open.id, closed.id].sort());
  assert.deepEqual(items.find(w => w.id === open.id), JSON.parse(JSON.stringify(open)));
  assert.deepEqual(items.find(w => w.id === closed.id), JSON.parse(JSON.stringify(closed)));
  assert.deepEqual(queriedTopics.splice(0), Array(3).fill(selected.metadata.uid), "Web excludes descendant and unrelated Topics");
  assert.deepEqual(await (await fetch(base + "/work?topicId=empty")).json(), []);
  const empty = aide.topics.resource("empty")!;
  assert.deepEqual(queriedTopics.splice(0), Array(3).fill(empty.metadata.uid));
  assert.deepEqual(await (await fetch(base + "/work?topicId=missing")).json(), []);
  assert.deepEqual(queriedTopics, []);
  assert.equal(aide.topics.resource("missing"), undefined, "Browsing does not create a Topic");

  assert.equal(await aide.personal.event({ id: "change-1", topicId: "selected", name: "changed", text: "Changed" }), 1);
  assert.deepEqual(queriedTopics.splice(0), [selected.metadata.uid, selected.metadata.uid]);
  const current = aide.works("selected").find(w => w.id === routine.id)!;
  const remove = (id: string, revision: number) => fetch(base + "/work/delete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, revision, topicId: "selected" }),
  });
  assert.equal((await remove(childWork.id, childWork.revision)).status, 404);
  assert.equal((await remove(other.id, other.revision)).status, 404);
  assert.equal((await remove(current.id, current.revision + 1)).status, 409);
  assert.equal((await remove(current.id, current.revision)).status, 200);
  assert.deepEqual((await (await fetch(base + "/work?topicId=selected")).json()).map((w: { id: string }) => w.id).sort(), [task.id, open.id, closed.id].sort(), "Deleting work is omitted from polling");
});
