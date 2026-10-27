import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ResourceListOptions, ResourceType } from "@compforge/aide-plugin";
import type { LogEntry } from "../src/host/logging.ts";
import { Manager } from "../src/host/plugin/manager.ts";
import { PluginInstanceStore } from "../src/host/plugin/instance.ts";
import { PluginSupervisor } from "../src/host/plugin/runner/index.ts";

const TYPE = { apiVersion: "tests.aide.dev/v1alpha1", kind: "ProcessCheck" };
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function waitFor(predicate: () => boolean, timeout = 3000) {
  const until = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > until) throw new Error("Missing diagnostic record"); await Bun.sleep(5); }
}
async function setup(timeoutMs: number, wait: () => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "aide-runner-diagnostics-")); roots.push(root);
  const entry = join(root, "package", "index.ts"); mkdirSync(join(root, "package"));
  cpSync(join(import.meta.dir, "fixtures/diagnostic-plugin.ts"), entry);
  const instances = new PluginInstanceStore({ home: root });
  instances.create({ pluginInstanceId: "diagnostics", pluginId: "tests/diagnostics", packageVersion: "1.0.0", marketplace: "fixtures" });
  const logs: LogEntry[] = [];
  const manager = new Manager({ instances, log: record => { logs.push(record); },
    pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: timeoutMs }),
    async loadPackageEntry(pluginId, version) { return { pluginId, version, entryUrl: pathToFileURL(entry).href,
      resourcesUrl: new URL("./fixtures/process-definitions.ts", import.meta.url).href }; },
  });
  // Delay only explicit resource.list calls after startup; no external service is involved.
  let delay = false;
  const original = manager.resourceClient.bind(manager);
  manager.resourceClient = id => {
    const client = original(id);
    return { ...client, async list<S, T>(type: ResourceType, options?: ResourceListOptions) {
      if (delay) await wait();
      return client.list<S, T>(type, options);
    } };
  };
  await manager.start(); delay = true;
  return { manager, logs, resources: original("diagnostics") };
}

test("timeout identifies a pending resource operation without mixing concurrent execution context or logging payloads", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await setup(750, () => gate);
  try {
    await f.resources.create(TYPE, { name: "waiting", spec: { mode: "wait", secret: "DO_NOT_LOG_PAYLOAD" } });
    await waitFor(() => f.logs.some(l => l.message === "Diagnostic fixture stage" && l.attributes?.name === "waiting"));
    await f.resources.create(TYPE, { name: "other", spec: { mode: "quick" } });
    await waitFor(() => f.logs.some(l => l.message === "Plugin Runner Controller execution timed out"));
    const timeout = f.logs.find(l => l.message === "Plugin Runner Controller execution timed out")!.attributes!;
    expect(timeout.resourceName).toBe("waiting");
    expect(timeout.resourceKind).toBe("ProcessCheck");
    expect(timeout.pendingHostCallCount).toBe(1);
    expect(timeout.pendingHostCalls).toMatchObject([{ method: "resource.list", resourceKind: "ProcessCheck" }]);
    expect(timeout.lastCompletedHostCall).toMatchObject({ method: "resource.get", resourceName: "waiting" });
    const stages = f.logs.filter(l => l.message === "Diagnostic fixture stage");
    expect(stages.find(l => l.attributes?.name === "waiting")?.attributes?.executionId).toBe(timeout.executionId);
    expect(stages.find(l => l.attributes?.name === "other")?.attributes?.executionId).not.toBe(timeout.executionId);
    expect(JSON.stringify(f.logs)).not.toContain("DO_NOT_LOG_PAYLOAD");
  } finally { release(); await f.manager.close(); }
});

test("timeout after Runner-local work reports no pending Host wait and retains the last completed operation", async () => {
  const f = await setup(750, async () => {});
  try {
    await f.resources.create(TYPE, { name: "cpu", spec: { mode: "cpu" } });
    await waitFor(() => f.logs.some(l => l.message === "Plugin Runner Controller execution timed out"));
    const timeout = f.logs.find(l => l.message === "Plugin Runner Controller execution timed out")!.attributes!;
    expect(timeout.pendingHostCallCount).toBe(0);
    expect(timeout.lastCompletedHostCall).toMatchObject({ method: "resource.get", resourceName: "cpu" });
    expect(timeout.operations).toMatchObject({ "resource.get": { count: 1 } });
  } finally { await f.manager.close(); }
});

test("slow Host operations report duration and result cardinality without serializing returned resources", async () => {
  const f = await setup(3000, () => Bun.sleep(1100));
  try {
    await f.resources.create(TYPE, { name: "slow", spec: { mode: "wait", secret: "DO_NOT_LOG_RESULT" } });
    await f.manager.settled();
    const slow = f.logs.find(l => l.message === "Plugin Runner Host operation slow")!.attributes!;
    expect(slow).toMatchObject({ method: "resource.list", resourceKind: "ProcessCheck", resultCount: 1, outcome: "success" });
    expect(slow.elapsedMs).toBeGreaterThanOrEqual(1000);
    expect(f.logs.find(l => l.message === "Plugin Runner Host round trip slow")?.attributes).toMatchObject({
      method: "resource.list", executionId: slow.executionId,
    });
    expect(slow.executionId).toBe(f.logs.find(l => l.message === "Diagnostic fixture stage")?.attributes?.executionId);
    expect(f.logs.some(l => l.message === "Plugin Runner Controller execution timed out")).toBe(false);
    expect(JSON.stringify(f.logs)).not.toContain("DO_NOT_LOG_RESULT");
  } finally { await f.manager.close(); }
});

test("Runner scheduling delay is visible separately from fast Host handling", async () => {
  const f = await setup(4000, () => Bun.sleep(100));
  try {
    await f.resources.create(TYPE, { name: "waiting", spec: { mode: "wait" } });
    await waitFor(() => f.logs.some(l => l.message === "Diagnostic fixture stage" && l.attributes?.name === "waiting"));
    await f.resources.create(TYPE, { name: "stall-runner", spec: { mode: "cpu" } });
    await f.manager.settled();
    const slow = f.logs.find(l => l.message === "Plugin Runner Host round trip slow" && l.attributes?.method === "resource.list")!.attributes!;
    expect(slow.hostHandlingMs).toBeLessThan(1000);
    expect(slow.outsideHostHandlingMs).toBeGreaterThanOrEqual(1000);
    expect(f.logs.some(l => l.message === "Plugin Runner Controller execution timed out")).toBe(false);
  } finally { await f.manager.close(); }
});
