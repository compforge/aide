import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { ReconcileDueQueue } from "../src/reconcile/queue.ts";
import type { ReconcileKey } from "../src/protocol/reconcile.ts";

/** @case Deadline replacement and cancellation never retain obsolete wakeups. */
test("due queue orders replacement deadlines and removes canceled keys and scopes", async () => {
  let now = 0;
  const fired: string[] = [];
  const queue = new ReconcileDueQueue({ now: () => new Date(now), onDue: key => fired.push(key.resourceId) });
  const key = (id: number): ReconcileKey => ({ pluginInstanceId: "test", namespace: "v1", resourceApiVersion: "test/v1",
    resourceKind: "Timer", resourceId: String(id), controllerName: id % 7 === 0 ? "removed" : "kept" });
  const expected = new Map<number, number>();
  try {
    for (let id = 0; id < 500; id++) { expected.set(id, 10000 + id); queue.schedule(key(id), new Date(10000 + id)); }
    for (let id = 0; id < 500; id += 2) { expected.set(id, 12000 - id); queue.schedule(key(id), new Date(12000 - id)); }
    for (let id = 1; id < 500; id += 3) { expected.set(id, 9000 + id); queue.schedule(key(id), new Date(9000 + id)); }
    for (let id = 0; id < 500; id += 5) { expected.delete(id); queue.schedule(key(id), null); }
    queue.removeScope(key(0));
    for (const id of expected.keys()) if (id % 7 === 0) expected.delete(id);
    now = 20000;
    queue.schedule(key(501), new Date(20000)); expected.set(501, 20000);
    for (let i = 0; i < 100 && fired.length < expected.size; i++) await delay(5);
    assert.deepEqual(fired, [...expected].sort((a, b) => a[1] - b[1]).map(([id]) => String(id)));
    await delay(10);
    assert.equal(fired.length, expected.size);
  } finally { queue.close(); }
});
