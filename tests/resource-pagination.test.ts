import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { ResourceDefinition, ResourceNamespace } from "@compforge/aide-plugin";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { ResourcePages } from "../src/host/resource/pages.ts";
const TYPE = { apiVersion: "tests.dev/v1", kind: "Page" };
const NEXT = { ...TYPE, apiVersion: "tests.dev/v2" };
const definition = (type = TYPE): ResourceDefinition => ({ type,
  schema: { spec: z.object({ group: z.string() }), status: z.record(z.string(), z.unknown()) },
  indexes: { group: r => [r.spec.group, r.spec.group] },
});
function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "pages-"));
  const store = new PluginResourceStore({ home, pluginInstanceId: "pages" });
  store.storage.register("pages", [definition(), definition(NEXT)]);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const client = createResourceClient(store);
  const create = (name: string, group = "selected", namespace: ResourceNamespace = "v1", labels = { selected: "yes" }) =>
    client.create(TYPE, { name, namespace, labels, spec: { group }, status: {} });
  return { store, client, create };
}
test("paged queries filter before limiting, return stable pages and decode only selected objects", async t => {
  const f = fixture(t);
  for (let i = 0; i < 90; i++) await f.create(String(i).padStart(3, "0"), i % 3 ? "other" : "selected", "v1", { selected: i % 2 ? "no" : "yes" });
  let reads = 0; const read = f.store.storage.read.bind(f.store.storage);
  f.store.storage.read = (...args) => { reads++; return read(...args); };
  const options = { limit: 4, matchIndex: { name: "group", value: "selected" }, matchLabels: { selected: "yes" } };
  let token = "", revision = ""; const names: string[] = [];
  do {
    reads = 0;
    const page = await f.client.listPage(TYPE, { ...options, continue: token });
    assert.equal(reads, page.items.length);
    assert.ok(page.items.length <= 4);
    assert.ok(Object.isFrozen(page.metadata) && Object.isFrozen(page.items));
    if (revision) assert.equal(page.metadata.resourceVersion, revision);
    revision = page.metadata.resourceVersion; token = page.metadata.continue;
    names.push(...page.items.map(r => r.metadata.name));
  } while (token);
  assert.deepEqual(names, Array.from({ length: 15 }, (_, i) => String(i * 6).padStart(3, "0")));

});
test("namespace boundaries, API versions and plugin scopes remain isolated across pages", async t => {
  const f = fixture(t);
  for (const namespace of ["v1", "v1/project/a", "v1/project/a/session/s", "v1/project/ab"] as const)
    for (const name of ["z", "A", "a", "中", "a/b"]) await f.create(name, "selected", namespace);
  await f.client.create(NEXT, { name: "hidden", spec: { group: "selected" } });
  const other = new PluginResourceStore({ home: f.store.storage.home, pluginInstanceId: "other" });
  other.storage.register("other", [definition()]);
  await createResourceClient(other).create(TYPE, { name: "hidden", spec: { group: "selected" } });
  const options = { namespace: "v1/project/a" as const, includeDescendants: true, limit: 3 };
  let token = ""; const found: string[] = [];
  do {
    const page = await f.client.listPage(TYPE, { ...options, continue: token });
    found.push(...page.items.map(r => `${r.metadata.namespace}:${r.metadata.name}`)); token = page.metadata.continue;
  } while (token);
  const expected = ["v1/project/a", "v1/project/a/session/s"].flatMap(n => ["z", "A", "a", "中", "a/b"].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(name => `${n}:${name}`));
  assert.deepEqual(found, expected);
});
test("continuations bind selectors, allow page size changes and expire on public mutations", async t => {
  const f = fixture(t); const a = await f.create("a"); await f.create("b"); await f.create("c");
  const page = await f.client.listPage(TYPE, { limit: 1 });
  const token = page.metadata.continue;
  await assert.rejects(f.client.listPage(TYPE, { limit: 1, continue: token, matchLabels: { selected: "yes" } }), { name: "ResourceContinueInvalid" });
  await assert.rejects(f.client.listPage(NEXT, { limit: 1, continue: token }), { name: "ResourceContinueInvalid" });
  assert.equal((await f.client.listPage(TYPE, { limit: 2, continue: token })).items.length, 2);
  await f.client.create(NEXT, { name: "unrelated", spec: { group: "selected" } });
  assert.equal((await f.client.listPage(TYPE, { limit: 2, continue: token })).items.length, 2, "Other API versions do not expire this collection");
  await f.client.patchStatus(a, {});
  f.store.storage.read(f.store.key(TYPE, "a"), true);
  const stored = f.store.storage.read(f.store.key(TYPE, "a"))!;
  f.store.storage.write(f.store.key(TYPE, "a"), "pages", { ...stored, control: { nextReconcileAt: new Date().toISOString() } });
  assert.equal((await f.client.listPage(TYPE, { limit: 2, continue: token })).items.length, 2, "No-op, LRU and control writes preserve collection revision");
  await assert.rejects(f.client.commit([
    { operation: "patchStatus", resource: a, patch: { changed: true } },
    { operation: "patch", resource: a, patch: { type: "json", value: [{ op: "test", path: "/spec/group", value: "wrong" }] } },
  ]));
  assert.equal((await f.client.listPage(TYPE, { limit: 2, continue: token })).items.length, 2, "Rolled-back writes preserve revision");
  await f.client.patchStatus(a, { changed: true });
  await assert.rejects(f.client.listPage(TYPE, { limit: 2, continue: token }), { name: "ResourceExpired" });
});
test("deletion, index rebuilds and Host restart invalidate cursors", async t => {
  const f = fixture(t); await f.create("a"); await f.create("b");
  const first = await f.client.listPage(TYPE, { limit: 1 });
  f.store.storage.remove(f.store.key(TYPE, "b"));
  await assert.rejects(f.client.listPage(TYPE, { limit: 1, continue: first.metadata.continue }), { name: "ResourceExpired" });
  await f.create("b");
  const next = await f.client.listPage(TYPE, { limit: 1 });
  f.store.storage.pages.invalidate("pages", TYPE);
  await assert.rejects(f.client.listPage(TYPE, { limit: 1, continue: next.metadata.continue }), { name: "ResourceExpired" });
  const latest = await f.client.listPage(TYPE, { limit: 1 });
  const restarted = new ResourcePages(f.store.storage.db);
  assert.throws(() => restarted.list("pages", TYPE, { limit: 1, continue: latest.metadata.continue }), { name: "ResourceExpired" });
});
test("invalid limits and unknown indexes fail even on empty collections", async t => {
  const f = fixture(t);
  for (const limit of [0, -1, 1.5, 1001, NaN, Infinity]) await assert.rejects(f.client.listPage(TYPE, { limit }), /1..1000/);
  await assert.rejects(f.client.listPage(TYPE, { limit: 1, matchIndex: { name: "missing", value: "x" } }), /Unknown resource index/);
  await assert.rejects(f.client.listPage(TYPE, { limit: 1, continue: "invalid" }), { name: "ResourceContinueInvalid" });
  const empty = await f.client.listPage(TYPE, { limit: 1 });
  assert.deepEqual(empty.items, []); assert.equal(empty.metadata.continue, "");
});

test("cursor encoding supports long canonical namespaces and equivalent label ordering", async t => {
  const f = fixture(t);
  const namespace = `v1/${"a".repeat(9000)}` as ResourceNamespace;
  await f.create("a", "selected", namespace, { selected: "yes" });
  await f.create("b", "selected", namespace, { selected: "yes" });
  const first = await f.client.listPage(TYPE, { namespace, limit: 1 });
  assert.equal((await f.client.listPage(TYPE, { namespace, limit: 1, continue: first.metadata.continue })).items[0]!.metadata.name, "b");
  const a = await f.create("a"); const b = await f.create("b");
  await f.client.patchMetadata(a, { labels: { second: "yes" } });
  await f.client.patchMetadata(b, { labels: { second: "yes" } });
  const options = { limit: 1, matchLabels: { selected: "yes", second: "yes" } };
  const page = await f.client.listPage(TYPE, options);
  const last = await f.client.listPage(TYPE, { ...options, matchLabels: { second: "yes", selected: "yes" }, continue: page.metadata.continue });
  assert.equal(last.items[0]!.metadata.name, "b"); assert.equal(last.metadata.continue, "");
});

/** @case A live traversal survives its own writes and restart, with a fixed upper key bound. */
test("live traversal advances across updates, removals and restart without growing its upper bound", async t => {
  const f = fixture(t);
  for (const name of ["a", "b", "c"]) await f.create(name);
  const query = { limit: 1, consistency: "live" as const, matchIndex: { name: "group", value: "selected" } };
  const first = await f.client.listPage(TYPE, query);
  await f.client.patchStatus(first.items[0]!, { changed: true });
  await f.create("aa"); await f.create("z");
  f.store.storage.remove(f.store.key(TYPE, "b"));
  const restarted = new ResourcePages(f.store.storage.db);
  const next = restarted.list("pages", TYPE, { ...query, continue: first.metadata.continue });
  assert.equal(next.keys[0], f.store.key(TYPE, "aa"));
  const last = restarted.list("pages", TYPE, { ...query, continue: next.metadata.continue });
  assert.deepEqual(last.keys, [f.store.key(TYPE, "c")]);
  assert.equal(last.metadata.continue, "");
  assert.throws(() => restarted.list("pages", TYPE, { ...query, matchIndex: { name: "group", value: "other" }, continue: next.metadata.continue }), { name: "ResourceContinueInvalid" });
});

test("production indexed page SQL uses ordered range seeks without a sorting table", async t => {
  const f = fixture(t);
  for (let i = 0; i < 80; i++) await f.create(String(i).padStart(3, "0"));
  const db = f.store.storage.db, prepare = db.prepare.bind(db);
  const plans: string[][] = [];
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    if (sql.includes(" AS key,") && sql.includes("resource_page_indexes")) {
      const all = statement.all.bind(statement);
      statement.all = ((...args: import("node:sqlite").SQLInputValue[]) => { plans.push(prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map(r => String(r.detail))); return all(...args); }) as typeof statement.all;
    }
    return statement;
  }) as typeof db.prepare;
  try {
    const query = { limit: 2, matchIndex: { name: "group", value: "selected" } };
    const first = await f.client.listPage(TYPE, query);
    await f.client.listPage(TYPE, { ...query, continue: first.metadata.continue });
  } finally { db.prepare = prepare; }
  assert.equal(plans.length, 2);
  for (const plan of plans) {
    assert.ok(plan.some(p => p.includes("COVERING INDEX resource_page_lookup")));
    assert.ok(plan.every(p => !p.includes("TEMP B-TREE")), plan.join("\n"));
  }
});

/** @case Existing resource indexes gain the ordered projection atomically at installation. */
test("ordered index installation backfills existing data and later replacements remove old memberships", async t => {
  const f = fixture(t); const a = await f.create("a"); await f.create("b", "other");
  f.store.storage.db.exec("DROP TRIGGER resource_page_index_insert; DROP TRIGGER resource_page_index_delete; DROP TABLE resource_page_indexes");
  const pages = new ResourcePages(f.store.storage.db);
  const query = { limit: 2, matchIndex: { name: "group", value: "selected" } };
  assert.deepEqual(pages.list("pages", TYPE, query).keys, [f.store.key(TYPE, "a")]);
  await f.client.replace(a, { group: "other" }, a.status);
  assert.deepEqual(pages.list("pages", TYPE, query).keys, []);
});
