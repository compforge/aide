import { expect, test } from "bun:test";
import { RunnerRecovery } from "../src/host/plugin/runner/recovery.ts";
import type { LogEntry } from "../src/host/logging.ts";

async function until(check: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error("Recovery did not settle"); await Bun.sleep(5); }
}

test("recovery awaits domain reconciliation and backs off repeated crashes", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let prepared = 0, activated = 0;
  const logs: LogEntry[] = [];
  const recovery = new RunnerRecovery({ backoff: { initialDelayMs: 10, maxDelayMs: 40 },
    enabled: () => true, log: entry => { logs.push(entry); },
    async prepare() { prepared++; await gate; },
    async activate() { activated++; if (activated === 1) recovery.fail("test", new Error("Crash during activation")); },
  });
  try {
    recovery.fail("test", new Error("Crash"));
    await until(() => prepared === 1);
    expect(activated).toBe(0);
    expect(recovery.has("test")).toBe(true);
    release(); await until(() => !recovery.has("test"));
    expect(prepared).toBe(2);
    expect(activated).toBe(2);
    recovery.fail("test", new Error("Crash again"));
    await until(() => !recovery.has("test"));
    expect(logs.filter(l => l.message === "Plugin Runner restart scheduled").map(l => l.attributes?.delayMs)).toEqual([10, 20, 40]);
  } finally { release(); await recovery.close(); }
});

test("failed reconciliation is retried before activation; disabling cancels the retry", async () => {
  let enabled = true, prepared = 0, activated = 0;
  const recovery = new RunnerRecovery({ backoff: { initialDelayMs: 30, maxDelayMs: 60 },
    enabled: () => enabled,
    async prepare() { prepared++; throw new Error("Cannot reconcile interrupted effects"); },
    async activate() { activated++; },
  });
  recovery.fail("test", new Error("Crash"));
  await until(() => prepared >= 2);
  enabled = false; await recovery.cancel("test");
  expect(activated).toBe(0);
  expect(recovery.has("test")).toBe(false);
  await recovery.close();
});

test("close waits for preparation and prevents late activation", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let activated = 0, closed = false;
  const recovery = new RunnerRecovery({ backoff: { initialDelayMs: 10, maxDelayMs: 40 }, enabled: () => true,
    prepare: () => gate, async activate() { activated++; },
  });
  recovery.fail("test", new Error("Crash"));
  const closing = recovery.close().then(() => { closed = true; });
  await Bun.sleep(10); expect(closed).toBe(false);
  release(); await closing;
  expect(activated).toBe(0);
});
