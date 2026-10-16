import assert from "node:assert/strict";
import { test } from "node:test";
import { ReconcileQueue } from "../src/runtime/queue.ts";

test("same work never executes concurrently, and repeated triggers keep one follow-up", async () => {
  let finish!: () => void;
  let calls = 0;
  let active = 0;
  const queue = new ReconcileQueue({ maxConcurrency: 2, execute: async () => {
    calls++;
    assert.equal(++active, 1);
    if (calls === 1) await new Promise<void>((resolve) => { finish = resolve; });
    active--;
  } });
  const first = queue.enqueue("task-a");
  const second = queue.enqueue("task-a");
  assert.equal(queue.enqueue("task-a"), second);
  finish();
  await Promise.all([first, second]);
  assert.equal(calls, 2);
  queue.close();
  await assert.rejects(queue.enqueue("task-a"), /closed/);
});
