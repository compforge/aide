import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceStorage, ResourceStorageConfigSchema, ResourceCapacityError, type StoredResource } from "../src/host/resource/storage.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { definition } from "./fixtures/resource-definition.ts";

function setup(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "resource-capacity-"));
  const db = new ResourceStorage(root);
  t.after(() => { db.db.close(); rmSync(root, { recursive: true, force: true }); });
  const type = { apiVersion: "example.dev/v1", kind: "Record" };
  const record = (id: string, released = true, refs: string[] = []): StoredResource => ({ object: { ...type,
    metadata: { name: id, uid: id, namespace: "v1", resourceVersion: "1", generation: 1, creationTimestamp: new Date(0).toISOString() },
    spec: { refs }, status: { released } } });
  for (const scope of ["one", "two"]) db.register(scope, ["example.dev/v1", "example.dev/v2"].map((apiVersion) => ({ ...definition({ ...type, apiVersion }), retention: {
    releasedAt: (r) => (r.status as { released: boolean }).released ? r.metadata.creationTimestamp : undefined,
    references: (r) => (r.spec as { refs: string[] }).refs ?? [] } })));
  db.configure(ResourceStorageConfigSchema.parse({ defaults: { maxCount: 3 }, lowWatermark: 0.9 }));
  return { root, db, record, type };
}

test("Group/Kind quota spans versions and scopes; protected references survive eviction and notifications follow commit", (t) => {
  const { db, record } = setup(t);
  const evicted: string[] = [];
  db.subscribe((_scope, r) => evicted.push(r.metadata.uid));
  db.write("a", "one", record("a"));
  const second = record("b"); second.object = { ...second.object, apiVersion: "example.dev/v2" };
  db.write("b", "two", second);
  db.write("c", "one", record("c", false, ["a"]));
  db.write("d", "two", record("d", false));
  assert.ok(db.has("a"), "An exact UID reference protects an otherwise released resource");
  assert.ok(!db.has("b")); assert.deepEqual(evicted, ["b"]);
  assert.throws(() => db.write("e", "one", record("e", false)), ResourceCapacityError);
  assert.ok(!db.has("e")); assert.deepEqual(evicted, ["b"], "Rollback cannot emit a deletion");
  assert.ok(db.has("a") && db.has("c") && db.has("d"));
});

test("LRU is explicit reads; listing does not refresh access, and unknown resource kinds are protected", (t) => {
  const { db, record } = setup(t);
  db.configure(ResourceStorageConfigSchema.parse({ defaults: { maxCount: 2, order: "lru" }, lowWatermark: 0.95 }));
  db.write("a", "one", record("a")); db.write("b", "one", record("b"));
  db.db.prepare("UPDATE resources SET accessed=0 WHERE key='b'").run();
  [...db.keys("one")]; db.read("a", true);
  db.write("c", "one", record("c", false));
  assert.ok(db.has("a")); assert.ok(!db.has("b"));
  const unknown = record("x"); unknown.object = { ...unknown.object, kind: "Unknown" };
  assert.throws(() => db.write("x", "one", unknown), /Unknown resource definition/);
  db.migrate("unknown-fixture", function* () { yield ["x", "one", unknown]; });
  assert.equal(db.db.prepare("SELECT released FROM resources WHERE key='x'").get()!.released, null);
});

test("Failed writes roll back receipts and collection; immutable history can shrink while over quota", (t) => {
  const { db, record } = setup(t);
  db.configure(ResourceStorageConfigSchema.parse({ defaults: { maxCount: 1 } }));
  db.write("a", "one", record("a", false));
  assert.throws(() => db.write("b", "one", record("b", false), { key: "event:b", value: "accepted" }), ResourceCapacityError);
  assert.equal(db.hasReceipt("event:b"), false);
  assert.equal(db.has("a"), true);
  const original = db.read("a")!;
  db.configure(ResourceStorageConfigSchema.parse({ defaults: { maxBytes: 1 } }));
  original.object = { ...original.object, spec: {} };
  assert.doesNotThrow(() => db.write("a", "one", original));
});

test("Plugin resources reopen from SQLite with the same version and bounded individual payloads", (t) => {
  const root = mkdtempSync(join(tmpdir(), "resource-sqlite-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { home: root, pluginInstanceId: "plugin" };
  const store = new PluginResourceStore(options);
  store.storage.configure(ResourceStorageConfigSchema.parse({ defaults: { maxResourceBytes: 1000 } }));
  const type = { apiVersion: "example.dev/v1", kind: "Document" };
  store.storage.register("plugin", [definition(type)]);
  const r = store.create({ type, name: "a", spec: { text: "small" } });
  assert.deepEqual(new PluginResourceStore(options).get(type, "a"), r);
  assert.throws(() => store.replaceSpec(type, "a", { text: "x".repeat(1000) }), ResourceCapacityError);
  assert.equal(store.get(type, "a").metadata.resourceVersion, r.metadata.resourceVersion);
});

/** @case A collected Input remains acknowledged within the dedup window, without restoring content or replaying a consumer. */
test("Collected Input redelivery is acknowledged without recreating the resource", async (t) => {
  const { InputStore } = await import("../plugins/personal/input/store.ts");
  const root = mkdtempSync(join(tmpdir(), "input-receipt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new InputStore(root);
  store.storage.configure(ResourceStorageConfigSchema.parse({ defaults: { maxCount: 1 } }));
  const spec = { origin: "source" as const, originId: "fixture", text: "fact" };
  const first = store.submit("owner", "one", spec);
  store.update(first, { routing: { phase: "done", reason: "ignored" } });
  store.submit("owner", "two", spec);
  assert.equal(store.get("one"), undefined);
  let notifications = 0; store.subscribe(() => notifications++);
  const duplicate = store.submit("owner", "one", spec);
  assert.equal(duplicate.metadata.creationTimestamp, first.metadata.creationTimestamp);
  assert.equal(duplicate.status.routing?.phase, "ignored");
  assert.equal(store.get("one"), undefined);
  assert.equal(notifications, 0);
  assert.throws(() => store.submit("other-owner", "one", spec), /different content or owner/);
});

test("Kind overrides inherit every unspecified default limit and order", () => {
  const config = ResourceStorageConfigSchema.parse({ defaults: { maxBytes: 4000, order: "lru" }, kinds: { "example.dev/Record": { maxCount: 5 } } });
  assert.deepEqual(config.kinds["example.dev/Record"], { maxCount: 5 });
  assert.deepEqual({ ...config.defaults, ...config.kinds["example.dev/Record"] }, { maxCount: 5, maxBytes: 4000, maxResourceBytes: 1048576, order: "lru" });
});
