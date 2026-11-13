import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { z } from "zod";
import type { ResourceDefinition, ResourceClient, PluginLogger, Resource } from "@compforge/aide-plugin";
import { ResourceStorage, type StoredResource } from "../src/host/resource/storage.ts";
import { ResourceGarbageCollector } from "../src/host/resource/gc.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { Controllers } from "../src/runner/controllers.ts";
import type { HostRequest } from "../src/protocol/ipc.ts";

const TYPE = { apiVersion: "startup.test/v1", kind: "Item" };
function definition(options: Partial<ResourceDefinition> = {}): ResourceDefinition {
  return { type: TYPE, schema: { spec: z.record(z.string(), z.unknown()), status: z.record(z.string(), z.unknown()) },
    indexes: { label: () => ["old"] }, retention: { releasedAt: () => undefined, references: () => [] }, ...options };
}
function record(name: string): StoredResource {
  return { object: { ...TYPE, metadata: { name, namespace: "v1", uid: name, generation: 1, resourceVersion: "1", creationTimestamp: new Date(0).toISOString() }, spec: { text: "payload" }, status: {} } };
}
function fixture(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "resource-startup-"));
  const opened: ResourceStorage[] = [];
  const open = () => { const db = new ResourceStorage(home); opened.push(db); return db; };
  t.after(() => { for (const db of opened) db.db.close(); rmSync(home, { recursive: true, force: true }); });
  return { home, open };
}

test("registration does no historical work; restart reuses indexes and yields while confirming retention", async t => {
  const { open } = fixture(t);
  const first = open(); first.register("owner", [definition()]);
  for (let i = 0; i < 150; i++) first.write(String(i), "owner", record(String(i).padStart(3, "0")));
  let indexes = 0, retention = 0;
  const restarted = open();
  restarted.register("owner", [definition({ indexes: { label: () => { indexes++; return ["old"]; } },
    retention: { releasedAt: () => { retention++; return undefined; }, references: () => [] } })]);
  assert.equal(indexes + retention, 0);
  assert.throws(() => restarted.page("owner", TYPE, { limit: 1 }), /not prepared/);
  let yields = 0, done = false;
  const heartbeat = async () => { while (!done) { await tick(); yields++; } };
  const beating = heartbeat();
  await restarted.prepare(); done = true; await beating;
  assert.equal(indexes, 0); assert.equal(retention, 150); assert.ok(yields >= 3);
  assert.equal(restarted.page("owner", TYPE, { limit: 1000, matchIndex: { name: "label", value: "old" } }).items.length, 150);
  await restarted.prepare(); assert.equal(retention, 150);
});

test("interrupted index preparation remains unavailable and retries the current definition after restart", async t => {
  const { open } = fixture(t);
  const first = open(); first.register("owner", [definition()]);
  for (let i = 0; i < 130; i++) first.write(String(i), "owner", record(String(i).padStart(3, "0")));
  const upgraded = open(); let calls = 0;
  upgraded.register("owner", [definition({ indexVersion: 2, indexes: { label: () => { if (++calls === 70) throw new Error("upgrade failed"); return ["new"]; } } })]);
  await assert.rejects(upgraded.prepare(), /upgrade failed/);
  assert.equal(upgraded.ready, false);
  assert.equal(upgraded.db.prepare("SELECT count(*) AS n FROM resource_index_versions").get()!.n, 0);
  assert.throws(() => upgraded.page("owner", TYPE, { limit: 1 }), /not prepared/);
  assert.throws(() => [...upgraded.indexedKeys("owner", TYPE, "", "label", "missing")], /not prepared/);
  const restarted = open(); let rebuilt = 0;
  restarted.register("owner", [definition({ indexVersion: 2, indexes: { label: () => { rebuilt++; return ["new"]; } } })]);
  await restarted.prepare(); assert.equal(rebuilt, 130);
  assert.equal(restarted.page("owner", TYPE, { limit: 1000, matchIndex: { name: "label", value: "new" } }).items.length, 130);
  assert.equal(restarted.db.prepare("SELECT count(*) AS n FROM resource_indexes WHERE value='old'").get()!.n, 0);
});

test("cancelled retention preparation protects the whole reference graph from GC", async t => {
  const { open } = fixture(t);
  const first = open(); first.register("owner", [definition()]);
  for (let i = 0; i < 100; i++) first.write(String(i), "owner", record(String(i).padStart(3, "0")));
  const db = open(), abort = new AbortController(); let visited = 0;
  db.register("owner", [definition({ retention: { releasedAt: () => { if (++visited === 2) abort.abort(); return new Date(0).toISOString(); }, references: () => [] } })]);
  await assert.rejects(db.prepare({ signal: abort.signal }), { name: "AbortError" });
  db.configure({ defaults: { maxCount: 1, maxBytes: 128 * 1024 * 1024, maxResourceBytes: 1024 * 1024, order: "released" } });
  const gc = new ResourceGarbageCollector(db, { lifecycle: () => "unmanaged" });
  await gc.run(); await gc.close();
  assert.equal(db.db.prepare("SELECT count(*) AS n FROM resources").get()!.n, 100);
  await db.prepare(); assert.equal(db.ready, true);
});

test("descendant list and identity discovery decode only requested payloads and retain complete list semantics", t => {
  const { home } = fixture(t);
  const store = new PluginResourceStore({ home, pluginInstanceId: "owner" });
  let decoded = 0;
  store.storage.register("owner", [definition({ schema: { spec: { parse: v => { decoded++; return v; } }, status: { parse: v => v } } }), definition({ type: { ...TYPE, kind: "Other" } })]);
  for (let i = 0; i < 270; i++) store.create({ type: TYPE, name: String(i), namespace: i % 2 ? "v1/target/child" : "v1/target", spec: {} });
  store.create({ type: { ...TYPE, kind: "Other" }, name: "other", spec: {} });
  store.create({ type: TYPE, name: "outside", namespace: "v1/target2", spec: {} });
  decoded = 0;
  const refs = store.storage.identities("owner", TYPE, { namespace: "v1/target", includeDescendants: true, limit: 64 });
  assert.equal(refs.items.length, 64); assert.equal(decoded, 0);
  assert.equal(store.list(TYPE, { namespace: "v1/target", includeDescendants: true }).length, 270);
  assert.equal(decoded, 270);
});

test("Runner starts before initial scan completes and accepts changes behind its cursor", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const seen: string[] = [];
  const requests: HostRequest[] = [];
  const call = async <T>(request: HostRequest): Promise<T> => {
    requests.push(request);
    if (request.method === "controller.scan") {
      await gate;
      return { items: [{ ...TYPE, namespace: "v1", name: request.continue ? "z" : "m" }], metadata: { continue: request.continue ? "" : "next", resourceVersion: "1" } } as T;
    }
    if (request.method === "controller.begin") seen.push(request.key.resourceId);
    return undefined as T;
  };
  const log = { info() {}, warn() {}, error() {}, debug() {} } as PluginLogger;
  const controllers = new Controllers("owner", {} as ResourceClient, call, log);
  controllers.register("items", { resourceType: TYPE, async reconcile() {} });
  await controllers.start("items", 1, { initialDelayMs: 1, maxDelayMs: 10 });
  await controllers.changed("items", { kind: "created", resource: record("a").object as Resource<unknown, unknown> });
  release(); await controllers.settled(); controllers.close();
  assert.deepEqual(seen.sort(), ["a", "m", "z"]);
  assert.equal(requests.filter(r => r.method === "controller.scan").length, 2);
});

test("one plugin's invalid historical data does not block another plugin's preparation", async t => {
  const { open } = fixture(t);
  const first = open(); first.register("bad", [definition()]); first.register("good", [definition()]);
  first.write("bad", "bad", record("bad")); first.write("good", "good", record("good"));
  const db = open();
  db.register("bad", [definition({ schema: { spec: z.object({ required: z.string() }), status: z.object({}) } })]);
  db.register("good", [definition()]);
  const failed = db.prepare({ scope: "bad" });
  const good = db.prepare({ scope: "good" });
  await assert.rejects(failed); await good;
  assert.equal(db.page("good", TYPE, { limit: 1 }).items.length, 1);
  assert.throws(() => db.page("bad", TYPE, { limit: 1 }), /not prepared/);
  assert.equal(db.ready, false, "GC remains gated on the complete registered reference graph");
});
