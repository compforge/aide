import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { fakeOptions } from "./fake-harness.ts";
import { browseTopics } from "../plugins/personal/topic/browse.ts";
import { TOPIC_TYPE, type TopicResource } from "../plugins/personal/topic/model.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { webAddress } from "../src/channel/address.ts";
import { httpChannel } from "../src/api/index.ts";
import type { TopicListView } from "../src/api/types.ts";

const log = pino({ level: "silent" });
function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-topic-list-"));
  const aide = new Aide(home, fakeOptions({ async chief() { return "ok"; }, async execute() { throw new Error("No Work expected"); } }, home), log);
  t.after(async () => { await aide.close(); rmSync(home, { recursive: true, force: true }); });
  return { aide, store: aide.topics, db: aide.topics.resources.storage.db };
}
function tieTopics(db: ReturnType<typeof setup>["db"]) {
  const at = "2000-01-01T00:00:00.000Z";
  db.prepare("UPDATE resources SET created=?, data=json_set(data, '$.object.metadata.creationTimestamp', ?) WHERE kind='aide.dev/Topic'").run(at, at);
}
function child(store: ReturnType<typeof setup>["store"], value: TopicResource, parent: TopicResource) {
  return store.resources.replace(TOPIC_TYPE, value.metadata.name, { ...value.spec, parentRef: resourceRef(parent) }, value.status);
}

/** @case Pinned Default and SQL ordering produce complete, deterministic pages, including tied activity timestamps. */
test("Topic SQL pages keep Default outside the quota, follow selection and clamp after deletion", async t => {
  const { store, db } = setup(t);
  await store.ensure("default");
  for (let i = 0; i < 21; i++) await store.ensure(`root-${String(i).padStart(2, "0")}`);
  tieTopics(db);
  const pages = [1, 2, 3].map(page => browseTopics(store, { page, pageSize: 10 }));
  assert.deepEqual(pages.map(p => p.items.length), [10, 10, 1]);
  assert.ok(pages.every(p => p.total === 21 && p.pinned[0]!.id === "default" && p.pages === 3));
  assert.deepEqual(pages.flatMap(p => p.items.map(i => i.id)), Array.from({ length: 21 }, (_, i) => `root-${String(i).padStart(2, "0")}`));
  assert.equal(browseTopics(store, { selectedId: "root-20", pageSize: 10 }).page, 3);
  assert.equal(browseTopics(store, { selectedId: "root-20", page: 2, pageSize: 10 }).page, 2);
  const resource = store.resource("root-20")!;
  store.inputStore.submit("test", "latest", { origin: "source", originId: "test", text: "quiet fact" }, {
    topic: resourceRef(resource), route: { completedAt: new Date().toISOString(), result: { topics: [resourceRef(resource)], reason: "fixture" } },
  });
  assert.equal(browseTopics(store, { selectedId: "root-20", pageSize: 10 }).page, 1);
  assert.equal(browseTopics(store, { page: 999, pageSize: 10 }).page, 3);
  const last = store.resource("root-19")!;
  store.resources.requestDeletion(TOPIC_TYPE, last.metadata.name);
  assert.equal(browseTopics(store, { page: 3, pageSize: 10 }).page, 2);
  assert.equal(browseTopics(store, { q: "absent", page: 8 }).page, 1);
  assert.equal(browseTopics(store, { q: "absent" }).pinned.length, 0);
});

/** @case Empty parent means roots; a parent ID filters only its immediate children before paging or search. */
test("Topic parent filtering excludes grandchildren and locates deep links without expanding the directory", async t => {
  const { store, db } = setup(t);
  const parent = await store.ensure("parent", undefined, "Parent");
  await store.ensure("other");
  for (let i = 0; i < 21; i++) child(store, await store.ensure(`child-${String(i).padStart(2, "0")}`, undefined, `Child ${i}`), parent);
  const middle = store.resource("child-20")!;
  child(store, await store.ensure("grandchild"), middle);
  tieTopics(db);
  assert.deepEqual(browseTopics(store).items.map(i => i.id), ["other", "parent"]);
  const second = browseTopics(store, { parentId: "parent", page: 2, pageSize: 10 });
  assert.equal(second.total, 21); assert.equal(second.pinned.length, 0); assert.equal(second.items.length, 10);
  assert.ok(second.items.every(i => i.parentUid === parent.metadata.uid));
  assert.deepEqual(browseTopics(store, { parentId: "parent", q: "CHILD 20" }).items.map(i => i.id), ["child-20"]);
  assert.equal(browseTopics(store, { parentId: "missing" }).total, 0);
  db.prepare("UPDATE resources SET accessed=0").run();
  const access = db.prepare("SELECT key, accessed FROM resources ORDER BY key").all();
  const selected = browseTopics(store, { parentId: "parent", selectedId: "grandchild", pageSize: 10 });
  assert.deepEqual(db.prepare("SELECT key, accessed FROM resources ORDER BY key").all(), access);
  assert.equal(selected.page, 3);
  assert.deepEqual(selected.path.map(i => i.id), ["parent", "child-20", "grandchild"]);
  assert.equal(browseTopics(store, { selectedId: "grandchild", pageSize: 1 }).page, 2);
  assert.equal(browseTopics(store, { q: "' OR 1=1 --" }).total, 0);
});

test("Topic summaries use indexed facts without global views and quiet input never erases the reply preview", async t => {
  const { aide, store, db } = setup(t);
  const topic = await store.ensure("topic", webAddress("topic"), "Named Topic");
  tieTopics(db);
  const work = await aide.work("topic").create({ kind: "task", title: "Check", instruction: "Inspect", trigger: null });
  store.outputStore.create("topic", "reply", { text: "Latest\n reply", topicId: "topic", topic: { ...resourceRef(topic), uid: topic.metadata.uid }, target: webAddress("topic") });
  store.inputStore.submit("test", "quiet", { origin: "source", originId: "test", text: "private source fact", observation: { huge: "secret".repeat(1000) } }, {
    topic: resourceRef(topic), route: { completedAt: new Date().toISOString(), result: { topics: [resourceRef(topic)], reason: "fixture" } },
  });
  const fail = () => { throw new Error("Global views must not be used for Web lists"); };
  store.list = fail; store.get = fail; store.inputs = fail; store.outputStore.list = fail; aide.works = fail; aide.outputs = fail;
  const before = db.prepare("SELECT key, accessed FROM resources ORDER BY key").all();
  const result = browseTopics(store);
  assert.equal(result.items[0]!.preview, "Latest reply");
  assert.equal(result.items[0]!.taskCount, 1); assert.equal(result.items[0]!.routineCount, 0);
  assert.ok(!JSON.stringify(result).includes("private source fact"));
  assert.deepEqual(db.prepare("SELECT key, accessed FROM resources ORDER BY key").all(), before);
  assert.ok(work.id);
});

test("Topic HTTP validates paging and filters and serves the integrated browser bundle", async t => {
  const { aide, store } = setup(t);
  await store.ensure("default"); await store.ensure("normal", undefined, "Needle");
  const server = httpChannel(aide, log); server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const result = await (await fetch(base + "/topics?pageSize=1&q=needle")).json() as TopicListView;
  assert.equal(result.total, 1); assert.equal(result.items[0]!.id, "normal"); assert.equal(result.pinned.length, 0);
  for (const query of ["page=0", "pageSize=101", "extra=true"]) assert.equal((await fetch(base + "/topics?" + query)).status, 400);
  const html = await (await fetch(base + "/?topic=normal")).text(); assert.match(html, /id="topic-parent"/);
  assert.equal((await fetch(base + "/app.js")).status, 200);
});
