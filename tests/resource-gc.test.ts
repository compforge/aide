import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ResourceStorage, ResourceCapacityError, type StoredResource } from "../src/host/resource/storage.ts";
import { ResourceGarbageCollector } from "../src/host/resource/gc.ts";
import { definition } from "./fixtures/resource-definition.ts";
import type { LogEntry } from "../src/host/logging.ts";

function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const home = mkdtempSync(join(tmpdir(), "resource-gc-"));
  const storage = new ResourceStorage(home), logs: LogEntry[] = [];
  let guards = 0;
  const types = ["Record", "Child"].map(kind => ({ apiVersion: "gc.test/v1", kind }));
  storage.register("test", types.map(type => ({ ...definition(type), retention: {
    releasedAt: r => r.status.released ? r.metadata.creationTimestamp : undefined,
    references: r => (r.spec.refs ?? []) as string[],
    canEvict: r => { guards++; return !r.status.blocked; },
  } })));
  const write = (id: string, options: { kind?: string; owner?: string; released?: boolean; blocked?: boolean; refs?: string[] } = {}) => {
    const value: StoredResource = { object: { apiVersion: "gc.test/v1", kind: options.kind ?? "Record",
      metadata: { name: id, uid: id, namespace: "v1", resourceVersion: "1", generation: 1, creationTimestamp: new Date(0).toISOString(),
        ...(options.owner ? { owner: { ...types[0]!, namespace: "v1", name: options.owner, uid: options.owner } } : {}) },
      spec: { refs: options.refs ?? [] }, status: { released: options.released ?? true, blocked: options.blocked ?? false } } };
    storage.write(id, "test", value);
  };
  const gc = new ResourceGarbageCollector(storage, { lifecycle: () => "unmanaged", log: entry => logs.push(entry) });
  t.after(async () => { await gc.close(); storage.db.close(); rmSync(home, { recursive: true, force: true }); });
  return { storage, gc, write, logs, guards: () => guards };
}

async function eventually(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < deadline, "GC did not converge"); await delay(5); }
}

test("admission rolls back immediately without examining eligible trees; pressure wakes GC outside the write", async t => {
  const f = fixture(t);
  f.write("old");
  f.storage.configure({ kinds: { "gc.test/Record": { maxCount: 1 } } });
  f.gc.start();
  const changes: string[] = [];
  f.storage.subscribeWrites((_scope, r) => changes.push(r.metadata.name));
  assert.throws(() => f.write("new"), ResourceCapacityError);
  assert.equal(f.guards(), 0);
  assert.ok(f.storage.has("old")); assert.equal(f.storage.has("new"), false);
  assert.deepEqual(changes, []);
  await eventually(() => !f.storage.has("old"));
  assert.deepEqual(changes, ["old"]);
  f.write("new");
});

test("periodic GC retries protected candidates after their eligibility changes", async t => {
  const f = fixture(t);
  f.write("old", { released: false });
  f.storage.configure({ gc: { intervalMs: 10, batchSize: 2, maxTreeSize: 16 }, kinds: { "gc.test/Record": { maxCount: 1 } } });
  f.gc.start(); await f.gc.run();
  assert.ok(f.storage.has("old"));
  f.write("old");
  await eventually(() => !f.storage.has("old"));
});

test("cross-kind ownership requires all members released, current guards and no external references", async t => {
  const f = fixture(t);
  f.write("owner"); f.write("child", { kind: "Child", owner: "owner", released: false });
  f.storage.configure({ kinds: { "gc.test/Child": { maxCount: 1 } } });
  await f.gc.run(); assert.ok(f.storage.has("owner"));
  f.write("child", { kind: "Child", owner: "owner", blocked: true });
  await f.gc.run(); assert.ok(f.storage.has("child"));
  f.write("ref", { refs: ["child"], released: false });
  f.write("child", { kind: "Child", owner: "owner" });
  await f.gc.run(); assert.ok(f.storage.has("owner"));
  f.write("ref", { released: false });
  await f.gc.run();
  assert.equal(f.storage.has("owner"), false); assert.equal(f.storage.has("child"), false); assert.ok(f.storage.has("ref"));
});

test("deleting resources still occupy quota and a controller owns finalization; restart resumes unmanaged deletion", async t => {
  const f = fixture(t); f.write("old");
  f.storage.write("old", "test", { ...f.storage.read("old")!, owner: "external-owner" });
  f.storage.configure({ kinds: { "gc.test/Record": { maxCount: 1 } } });
  const controlled = new ResourceGarbageCollector(f.storage, { lifecycle: () => "controller" });
  await controlled.run(); await controlled.close();
  assert.ok(f.storage.read("old")!.object.metadata.deletionTimestamp);
  assert.equal(f.storage.read("old")!.owner, "external-owner");
  assert.throws(() => f.write("new"), ResourceCapacityError);
  const unavailable = new ResourceGarbageCollector(f.storage, { lifecycle: () => "unavailable" });
  await unavailable.run(); await unavailable.close(); assert.ok(f.storage.has("old"));
  // A new GC instance discovers persistent deletion marks without an in-memory work queue.
  await f.gc.run(); assert.equal(f.storage.has("old"), false);
  f.write("new");
});

test("no released saturated-kind resource means no unrelated tree guards or JSON subtree expansion", async t => {
  const f = fixture(t);
  for (let i = 0; i < 1000; i++) f.write(`unrelated-${i}`);
  f.write("protected-child", { kind: "Child", released: false });
  f.storage.configure({ kinds: { "gc.test/Child": { maxCount: 1 } } });
  await f.gc.run(); assert.equal(f.guards(), 0);
  assert.equal(f.logs.at(-1)?.attributes?.checked, 0);
  const plan = f.storage.db.prepare("EXPLAIN QUERY PLAN SELECT key FROM resources WHERE json_extract(data,'$.object.metadata.owner.uid')=?").all("owner");
  assert.match(JSON.stringify(plan), /resource_owner/);
});

test("oversized trees are preserved with diagnostics; a blocked first page does not starve later candidates", async t => {
  const f = fixture(t);
  f.write("a"); f.write("a-child", { kind: "Child", owner: "a" }); f.write("a-child2", { kind: "Child", owner: "a" });
  f.write("b");
  f.storage.configure({ gc: { intervalMs: 60_000, batchSize: 1, maxTreeSize: 2 }, kinds: { "gc.test/Record": { maxCount: 2 } } });
  await f.gc.run();
  assert.ok(f.storage.has("a")); assert.ok(f.storage.has("a-child")); assert.equal(f.storage.has("b"), false);
  assert.ok(f.logs.some(log => log.level === "warn" && log.attributes?.maxTreeSize === 2));
});

test("a failing deletion validator rolls back every mark and emits no partial tree changes", async t => {
  const f = fixture(t);
  const type = { apiVersion: "gc.test/v1", kind: "Veto" };
  f.storage.register("test", [{ ...definition(type), retention: { releasedAt: r => r.metadata.creationTimestamp, references: () => [] },
    validator: { delete: () => { throw new Error("still needed"); } } }]);
  f.write("owner"); f.write("child", { kind: "Veto", owner: "owner" });
  const changes: string[] = [];
  f.storage.subscribeWrites((_scope, r) => changes.push(r.metadata.name));
  f.storage.configure({ kinds: { "gc.test/Record": { maxCount: 1 } } });
  await f.gc.run();
  assert.equal(f.storage.read("owner")!.object.metadata.deletionTimestamp, undefined);
  assert.equal(f.storage.read("child")!.object.metadata.deletionTimestamp, undefined);
  assert.deepEqual(changes, []); assert.ok(f.logs.some(log => log.level === "error"));
});

test("Manager routes GC deletion through the registered Controller before finalizing", async t => {
  const { Manager } = await import("../src/host/plugin/manager.ts");
  const { PluginInstanceStore } = await import("../src/host/plugin/instance.ts");
  const { PluginResourceStore } = await import("../src/host/plugin/resource/store.ts");
  const home = mkdtempSync(join(tmpdir(), "gc-controller-"));
  const store = new PluginResourceStore({ home, pluginInstanceId: "test" });
  const type = { apiVersion: "gc.test/v1", kind: "Managed" };
  store.storage.register("test", [{ ...definition(type), retention: { releasedAt: r => r.metadata.creationTimestamp, references: () => [] } }]);
  const original = store.create({ type, name: "old", spec: {} });
  store.storage.configure({ kinds: { "gc.test/Managed": { maxCount: 1 } } });
  let cleanupStarted = false, complete!: () => void;
  const cleanup = new Promise<void>(resolve => { complete = resolve; });
  const manager = new Manager({ instances: new PluginInstanceStore({ home }) });
  t.after(async () => { complete(); await manager.close(); store.storage.db.close(); rmSync(home, { recursive: true, force: true }); });
  manager.registerController({ store, resourceType: type, reconcile: async (_context, resource) => {
    if (resource.metadata.deletionTimestamp) { cleanupStarted = true; await cleanup; }
  } });
  await manager.start();
  await eventually(() => cleanupStarted);
  assert.equal(store.get(type, "old").metadata.uid, original.metadata.uid);
  assert.throws(() => store.create({ type, name: "new", spec: {} }), ResourceCapacityError);
  complete(); await manager.settled();
  assert.equal(store.find(type, "old"), undefined);
  store.create({ type, name: "new", spec: {} });
});

test("periodic GC retains released history below quotas and global pressure can collect another kind", async t => {
  const f = fixture(t);
  f.write("history"); f.write("protected", { kind: "Child", released: false });
  await f.gc.run();
  assert.ok(f.storage.has("history"), "released alone is not a deletion request");
  const bytes = Number(f.storage.db.prepare("SELECT sum(bytes) AS n FROM resources").get()!.n);
  f.storage.configure({ maxBytes: bytes });
  assert.throws(() => f.write("incoming", { kind: "Child", released: false }), ResourceCapacityError);
  assert.ok(f.storage.capacityPressure.has("*"));
  await f.gc.run();
  assert.equal(f.storage.has("history"), false); assert.ok(f.storage.has("protected"));
});

test("GC coalesces overlapping runs and stops periodic work on close", async t => {
  const f = fixture(t); f.write("old", { released: false });
  f.storage.configure({ gc: { intervalMs: 10, batchSize: 1, maxTreeSize: 16 }, kinds: { "gc.test/Record": { maxCount: 1 } } });
  f.gc.start();
  const first = f.gc.run(); assert.equal(f.gc.run(), first); await first;
  await f.gc.close();
  f.write("old"); await delay(30);
  assert.ok(f.storage.has("old"));
});

test("GC propagates an absent or deleting owner through protected dependents without capacity pressure", async t => {
  const f = fixture(t);
  // The child sorts before its parent; the next coalesced pass must recover this edge too.
  f.write("z-owner", { released: false });
  f.write("b-child", { kind: "Child", owner: "z-owner", released: false });
  f.write("a-grandchild", { kind: "Child", owner: "b-child", released: false });
  f.storage.requestDeletion("z-owner");
  f.gc.start();
  await eventually(() => !f.storage.has("a-grandchild") && !f.storage.has("b-child") && !f.storage.has("z-owner"));
  f.write("orphan", { kind: "Child", owner: "missing", released: false });
  await f.gc.run(); assert.equal(f.storage.has("orphan"), false);
});
