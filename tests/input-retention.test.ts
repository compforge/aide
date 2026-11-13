import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceStorage, ResourceStorageConfigSchema } from "../src/host/resource/storage.ts";
import { ResourceGarbageCollector } from "../src/host/resource/gc.ts";
import { InputDefinition } from "../plugins/personal/input/definition.ts";
import { INPUT_TYPE, type InputStatus } from "../plugins/personal/input/model.ts";
import { inputPolicy } from "../plugins/personal/input/config.ts";
import { definition } from "./fixtures/resource-definition.ts";

const at = (age: number) => new Date(Date.now() - age * 1000).toISOString();
const policy = { successSeconds: 86400, errorSeconds: 7 * 86400 };
function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = mkdtempSync(join(tmpdir(), "aide-input-retention-"));
  const storage = new ResourceStorage(home);
  storage.register("personal", [InputDefinition, { ...definition({ apiVersion: "test/v1", kind: "Blocker" }),
    retention: { releasedAt: () => undefined, references: r => r.spec.refs as string[] } }]);
  const gc = new ResourceGarbageCollector(storage, { lifecycle: () => "unmanaged" });
  t.after(async () => { await gc.close(); storage.db.close(); rmSync(home, { recursive: true, force: true }); });
  const write = (id: string, status: InputStatus = { route: { completedAt: at(1) }, assess: {} }, created = at(60)) => {
    storage.write(id, "personal", { object: { ...INPUT_TYPE, metadata: { name: id, uid: id, namespace: "v1", resourceVersion: "1", generation: 1, creationTimestamp: created },
      spec: { origin: "source", originId: "fixture", text: id }, status: { retention: policy, ...status } } });
  };
  const count = () => Number(storage.db.prepare("SELECT count(*) AS n FROM resources WHERE kind='aide.dev/Input'").get()!.n);
  return { storage, gc, write, count };
}

/** @case Arrival is a hard deadline even for unprocessed/retrying/referenced Inputs; completion can shorten it. */
test("Input expiry bounds every state and does not depend on capacity pressure", async t => {
  const f = fixture(t);
  f.write("completed", { route: { completedAt: at(86401) } });
  f.write("failed-recent", { route: { completedAt: at(20) }, assess: { lastError: "failed", errorAt: at(10) } });
  f.write("failed-old", { route: { completedAt: at(20) }, assess: { lastError: "failed", errorAt: at(10) } }, at(7 * 86400 + 1));
  f.write("pending-old", undefined, at(7 * 86400 + 1));
  f.write("retry-old", { route: { lastError: "retry", errorAt: at(10), retryable: true, nextAttemptAt: at(-60) } }, at(7 * 86400 + 1));
  f.write("pending-recent");
  f.storage.write("blocker", "personal", { object: { apiVersion: "test/v1", kind: "Blocker",
    metadata: { name: "blocker", uid: "blocker", namespace: "v1", resourceVersion: "1", generation: 1, creationTimestamp: at(1) },
    spec: { refs: ["pending-old"] }, status: {} } });
  await f.gc.run();
  for (const id of ["completed", "failed-old", "pending-old", "retry-old"]) assert.equal(f.storage.has(id), false, id);
  for (const id of ["failed-recent", "pending-recent", "blocker"]) assert.ok(f.storage.has(id), id);
});

test("Retried errors and unfinished Work do not get completion-based expiry", async t => {
  const f = fixture(t);
  f.write("retry", { route: { lastError: "temporary", errorAt: at(2 * 86400), retryable: true, nextAttemptAt: at(-60) } }, at(3 * 86400));
  f.write("work", { route: { completedAt: at(2 * 86400) }, assess: { completedAt: at(2 * 86400) }, handle: { work: {
    resource: { apiVersion: "aide.dev/v1alpha6", kind: "Task", name: "work", namespace: "v1", uid: "work" },
    assignedAt: at(2 * 86400), request: { action: "context", note: "work pending" },
  } } }, at(3 * 86400));
  await f.gc.run(); assert.equal(f.count(), 2);
});

for (const [count, state, removed] of [[18, "completed", true], [18, "failed", false], [19, "failed", true], [19, "pending", false], [20, "pending", true]] as const) {
  test(`Input pressure ${count}/20 with ${state} respects each watermark`, async t => {
    const f = fixture(t);
    f.storage.configure({ kinds: { "aide.dev/Input": { maxCount: 20 } } });
    f.write("candidate", state === "completed" ? { route: { completedAt: at(1) } }
      : state === "failed" ? { route: { completedAt: at(20) }, assess: { lastError: "failed", errorAt: at(10) } } : undefined, at(120));
    for (let i = 1; i < count; i++) f.write(`pending-${i}`);
    await f.gc.run();
    assert.equal(f.storage.has("candidate"), !removed);
    assert.equal(f.count(), count - Number(removed));
  });
}

test("Expiry precedes pressure tiers and each stage recomputes the current water level", async t => {
  const f = fixture(t);
  f.storage.configure({ kinds: { "aide.dev/Input": { maxCount: 20 } } });
  f.write("expired", undefined, at(7 * 86400 + 1));
  f.write("completed", { route: { completedAt: at(1) } });
  f.write("failed", { route: { completedAt: at(10) }, assess: { lastError: "failed", errorAt: at(2) } });
  for (let i = 3; i < 20; i++) f.write(`pending-${i}`);
  await f.gc.run();
  assert.equal(f.storage.has("expired"), false); assert.equal(f.storage.has("completed"), false);
  assert.ok(f.storage.has("failed")); assert.equal(f.count(), 18);
});

test("Input retention and resource watermarks validate strict ordering", () => {
  assert.deepEqual(inputPolicy().retention, policy);
  assert.throws(() => inputPolicy({ retention: { successSeconds: 10, errorSeconds: 10 } }));
  assert.equal(ResourceStorageConfigSchema.parse({}).lowWatermark, 0.9);
  assert.equal(ResourceStorageConfigSchema.parse({}).highWatermark, 0.95);
  assert.throws(() => ResourceStorageConfigSchema.parse({ lowWatermark: 0.95, highWatermark: 0.9 }));
});

test("A successful write at the low watermark wakes GC before any create is rejected", async t => {
  const f = fixture(t);
  f.storage.configure({ kinds: { "aide.dev/Input": { maxCount: 20 } } });
  f.gc.start(); await f.gc.run();
  for (let i = 0; i < 17; i++) f.write(`pending-${i}`);
  f.write("completed", { route: { completedAt: at(1) } });
  const deadline = Date.now() + 2000;
  while (f.storage.has("completed") && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.storage.has("completed"), false); assert.equal(f.count(), 17);
});

test("Global byte pressure uses the same tiers and rechecks after completed Inputs are removed", async t => {
  const f = fixture(t);
  f.write("completed", { route: { completedAt: at(1) } });
  f.write("failed", { route: { completedAt: at(20) }, assess: { lastError: "failed", errorAt: at(10) } });
  for (let i = 2; i < 20; i++) f.write(`pending-${i}`);
  const bytes = Number(f.storage.db.prepare("SELECT sum(bytes) AS n FROM resources").get()!.n);
  f.storage.configure({ maxBytes: Math.floor(bytes / 0.96) });
  await f.gc.run();
  assert.equal(f.storage.has("completed"), false); assert.ok(f.storage.has("failed")); assert.equal(f.count(), 19);
});
