import { expect, test } from "bun:test";
import { ReconcileCapacity, ReconcileQueue } from "../src/reconcile/queue.ts";
import type { ReconcileKey } from "../src/protocol/reconcile.ts";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await Bun.sleep(5);
  }
  throw new Error("Capacity transition did not complete");
}

test("verb completion resumes above capacity, blocking new admission until below the limit", async () => {
  const capacity = new ReconcileCapacity(1);
  const verb = deferred(), resumedWork = deferred(), otherWork = deferred();
  const events: string[] = [];
  const first = capacity.run(async lease => {
    events.push("first");
    await lease.suspend(verb.promise);
    events.push("resumed");
    await resumedWork.promise;
  });
  const second = capacity.run(async () => { events.push("second"); await otherWork.promise; });
  const third = capacity.run(async () => { events.push("third"); });
  try {
    expect(events).toEqual(["first", "second"]);
    verb.resolve();
    await waitFor(() => events.includes("resumed"));
    expect(events).toEqual(["first", "second", "resumed"]);
    otherWork.resolve();
    await second;
    expect(events).not.toContain("third");
    resumedWork.resolve();
    await Promise.all([first, third]);
    expect(events).toEqual(["first", "second", "resumed", "third"]);
  } finally { verb.resolve(); resumedWork.resolve(); otherWork.resolve(); await Promise.allSettled([first, second, third]); }
});

test("parallel verb waits restore one lease, including rejected waits", async () => {
  const capacity = new ReconcileCapacity(1);
  const a = deferred(), b = deferred(), after = deferred();
  let resumed = false, nextStarted = false;
  const first = capacity.run(async lease => {
    const results = await Promise.allSettled([
      lease.suspend(a.promise).then(() => { resumed = true; }),
      lease.suspend(b.promise),
    ]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
  });
  a.resolve();
  await waitFor(() => resumed);
  const next = capacity.run(async () => { nextStarted = true; await after.promise; });
  try {
    expect(nextStarted).toBe(false);
    b.reject(new Error("cancelled"));
    await first;
    await waitFor(() => nextStarted);
    let extraStarted = false;
    const extra = capacity.run(async () => { extraStarted = true; });
    expect(extraStarted).toBe(false);
    after.resolve();
    await Promise.all([next, extra]);
  } finally { a.resolve(); b.resolve(); after.resolve(); await Promise.allSettled([first, next]); }
});

test("a late parallel result cannot resurrect capacity after execution fails", async () => {
  const capacity = new ReconcileCapacity(1);
  const failed = deferred(), late = deferred(), other = deferred();
  let lateSettled = false, otherStarted = false;
  const execution = capacity.run(async lease => {
    await Promise.all([lease.suspend(failed.promise), lease.suspend(late.promise).then(() => { lateSettled = true; })]);
  });
  failed.reject(new Error("cancelled"));
  await expect(execution).rejects.toThrow("cancelled");
  const next = capacity.run(async () => { otherStarted = true; await other.promise; });
  expect(otherStarted).toBe(true);
  late.resolve();
  await waitFor(() => lateSettled);
  let finalStarted = false;
  const final = capacity.run(async () => { finalStarted = true; });
  expect(finalStarted).toBe(false);
  other.resolve();
  await next;
  await waitFor(() => finalStarted);
  await final;
});

test("same-resource serialization spans suspension and unconditional resumption", async () => {
  const verb = deferred(), other = deferred();
  const events: string[] = [];
  let firstRuns = 0;
  const key = (name: string): ReconcileKey => ({ pluginInstanceId: "test", namespace: "v1", resourceApiVersion: "test/v1", resourceKind: "Item", resourceId: name });
  const queue = new ReconcileQueue({ maxConcurrency: 1, async execute(item, lease) {
    if (item.resourceId === "first") {
      events.push(`first-${++firstRuns}`);
      if (firstRuns === 1) { await lease.suspend(verb.promise); events.push("resumed"); }
    } else { events.push("other"); await other.promise; }
  } });
  const first = queue.enqueue(key("first"));
  const repeat = queue.enqueue(key("first"));
  const second = queue.enqueue(key("other"));
  try {
    expect(events).toEqual(["first-1", "other"]);
    verb.resolve();
    await first;
    expect(events).toEqual(["first-1", "other", "resumed"]);
    other.resolve();
    await Promise.all([second, repeat]);
    expect(events).toEqual(["first-1", "other", "resumed", "first-2"]);
  } finally { verb.resolve(); other.resolve(); queue.close(); await Promise.allSettled([first, repeat, second]); }
});
