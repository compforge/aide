import { resolveEnvironmentConfig } from "../connectors/environments/config.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { runProbe } from "./fixtures/resource-probe.ts";
const PROCESS_TYPE = { apiVersion: "tests.aide.dev/v1alpha1", kind: "ProcessCheck" };
const ENVIRONMENT_TYPE = { apiVersion: "tests.aide.dev/v1alpha1", kind: "EnvironmentCheck" };
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";


import { PluginInstanceStore } from "../src/host/plugin/instance.ts";
import { Manager, type PluginRunnerFailure } from "../src/host/plugin/manager.ts";
import { PluginSupervisor } from "../src/host/plugin/runner/index.ts";
import {
  restoredError,
  serializedError,
} from "../src/protocol/ipc.ts";
import { HarnessFixtures } from "./harness-fixture.ts";
import { createConnectors } from "./connector-fixture.ts";
import { Environments } from "../connectors/environments.ts";

const roots: string[] = [];

function stores() {
  const root = mkdtempSync(join(tmpdir(), "aide-plugin-runner-"));
  roots.push(root);
  const sessionHandle = new HarnessFixtures(root).create({ id: "runner", cwd: root });
  const packageDir = join(root, "installed-package");
  const entry = join(packageDir, "index.ts");
  mkdirSync(packageDir, { recursive: true });
  // Installed Marketplace Packages have no node_modules. Type-only imports
  // must erase cleanly instead of resolving through Aide's dependency tree.
  cpSync(join(import.meta.dir, "fixtures", "process-plugin.ts"), entry);
  return {
    root,
    instances: new PluginInstanceStore({ home: root }),
    session: sessionHandle,
    entry,
  };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Plugin Runner process boundary", () => {
  test("two unrelated plugin instances share the host connector capabilities without personal config", async () => {
    const { instances, session, entry } = stores();
    cpSync(join(import.meta.dir, "fixtures", "environment-plugin.ts"), entry);
    for (const id of ["first", "second"]) instances.create({
      pluginInstanceId: id, pluginId: "tests/environment-plugin", packageVersion: "1.0.0", marketplace: "fixtures",
    });
    const requirement = { source: "work", category: "story", id: "1", title: "Shared", state: "open" as const };
    const identity = { repository: { forge: { name: "forge" }, path: "org/repo" }, number: 1 };
    const pull = { ...identity, title: "Shared PR", url: "https://example.com/1", state: "open" as const,
      reviewThreads: "none" as const, conflictState: "none" as const, mergeReadiness: "ready" as const, observedAt: "2026-10-19T00:00:00Z" };
    let reads = 0;
    const connectors = createConnectors([{
      source: "work", provider: "fixture", async identity() { return { provider: "fixture", scope: "p" }; }, async comments() { return { items: [] }; }, async list() { reads++; return { items: [requirement] }; }, async get() { return requirement; },
    }], [{
      forge: "forge", provider: "github",
      async listRepositories() { return {items: [identity.repository]}; },
      async scanPullRequests() { return { items: [], cursor: "fixture" as import("@compforge/repocli").PullRequestScanCursor, pending: false, complete: true, issues: [] }; },
      async listPullRequests() { return {items: [identity]}; }, async getPullRequest() { return pull; },
      async getPullRequestReview() { return {key: identity, reviewThreadState: "none" as const, observedAt: "2026-10-19T00:00:00Z"}; },
      async listPullRequestComments() { return []; },
    }], new Environments(resolveEnvironmentConfig({ dev: { kind: "host", aliases: ["开发"], host: { name: "vm", transport: "ssh", address: "not-contacted.invalid" } } })));
    const failures: unknown[] = [];
    const manager = new Manager({
      instances, log: entry => session.log(entry), connectors, pluginSupervisor: new PluginSupervisor(),
      onActivationError: ({ error }) => { failures.push(error); },
      async loadPackageEntry(pluginId, version) { return { pluginId, version, entryUrl: pathToFileURL(entry).href, resourcesUrl: pluginId === "tests/process-plugin" ? new URL("./fixtures/process-definitions.ts", import.meta.url).href : new URL("./fixtures/environment-definitions.ts", import.meta.url).href }; },
    });
    try {
      await manager.start();
      expect(failures).toEqual([]);
      for (const id of ["first", "second"]) {
        expect(manager.isInstanceActive(id)).toBe(true);
        const response = await runProbe(manager, id, ENVIRONMENT_TYPE, "inspect");
        expect(response).toMatchObject({
          environment: { name: "dev", host: { address: "not-contacted.invalid" } },
          catalog: { requirements: [{ source: "work", provider: "fixture" }], forges: [{ forge: "forge", provider: "github" }] },
          requirementAccount: { provider: "fixture", scope: "p" }, requirementComments: { items: [] },
          requirements: { items: [requirement] }, requirement, repositories: { items: [identity.repository] }, pulls: {items: [identity]}, pull, comments: [],
        });
        await expect(runProbe(manager, id, ENVIRONMENT_TYPE, "missing")).rejects.toThrow("Unknown environment: missing");
      }
      expect(reads).toBe(2);
      expect(instances.list().every((instance) => Object.keys(instance.config).length === 0)).toBe(true);
    } finally { await manager.close(); }
  });

  test("preserves nested error causes across IPC serialization", () => {
    const restored = restoredError(serializedError(
      new Error("Could not list Forge PullRequests", {
        cause: new Error("GET /repos/openai/plugins/pulls returned 404"),
      }),
    ));

    expect(restored.message).toBe("Could not list Forge PullRequests");
    expect(restored.cause).toBeInstanceOf(Error);
    expect((restored.cause as Error).message).toBe(
      "GET /repos/openai/plugins/pulls returned 404",
    );
  });

  test("routes reconcile capabilities across the process boundary", async () => {
    const outputs: string[] = [];
    const { instances, session, entry } = stores();
    session.appendEvent({
      kind: "_aide_invocation_summary",
      source: { type: "aide" },
      harness: "codex",
      harnessName: "codex_default",
      invocationId: "turn_runner",
      payload: {
        invocationId: "turn_runner",
        userText: "test reconcile capabilities",
        agentText: "ready",
        toolCalls: [],
      },
    });
    instances.create({
      pluginInstanceId: "process_default",
      pluginId: "tests/process-plugin",
      marketplace: "fixtures",
      packageVersion: "1.0.0",
    });
    const manager = new Manager({
      actions: { "process_default/notify": async (_scope, input) => { const text = (input as { text: string }).text; outputs.push(text); await Bun.sleep(350); return { outputId: `out-${outputs.length}` }; } },
      instances,
      log: entry => session.log(entry),
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          namespace: "v1",
          entryUrl: pathToFileURL(entry).href, resourcesUrl: pluginId === "tests/process-plugin" ? new URL("./fixtures/process-definitions.ts", import.meta.url).href : new URL("./fixtures/environment-definitions.ts", import.meta.url).href,
        };
      },
    });

    await manager.start();
    await manager.resourceClient("process_default").create({ apiVersion: "tests.aide.dev/v1alpha1", kind: "Review" }, { name: "turn_crash", spec: {} });
    await waitFor(() => outputs.length === 1);
    expect(outputs).toEqual(["Review turn_crash?"]);
    await Bun.sleep(300);
    expect(manager.isInstanceActive("process_default")).toBe(true);
    await manager.settled();
    expect(session.projection.approvals.size).toBe(0);
    await manager.close();
  });

  test("routes Hook notifications and verbs across the process boundary", async () => {
    const outputs: string[] = [];
    const { instances, session, entry } = stores();
    instances.create({
      pluginInstanceId: "process_default",
      pluginId: "tests/process-plugin",
      marketplace: "fixtures",
      packageVersion: "1.0.0",
    });
    const manager = new Manager({
      actions: { "process_default/notify": async (_scope, input) => { const text = (input as { text: string }).text; outputs.push(text); await Bun.sleep(350); return { outputId: `out-${outputs.length}` }; } },
      instances,
      log: entry => session.log(entry),
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          namespace: "v1",
          entryUrl: pathToFileURL(entry).href, resourcesUrl: pluginId === "tests/process-plugin" ? new URL("./fixtures/process-definitions.ts", import.meta.url).href : new URL("./fixtures/environment-definitions.ts", import.meta.url).href,
        };
      },
    });
    await manager.start();

    const notification = manager.inlineHook("harness.input", {
      invocationId: "say-from-hook", attemptId: "attempt", harnessName: "codex",
      messageId: "message", operation: "new_turn",
    });
    await waitFor(() => outputs.length === 1);
    expect(outputs).toEqual(["Continue from Hook?"]);
    await expect(notification).resolves.toBeUndefined();

    await session.flushLogs();
    const records = readFileSync(join(session.dir, "harness-runtime.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({
      source: "plugin",
      component: "plugin.tests/process-plugin.hook",
      message: "Process Hook observed input",
      attributes: { inputId: "say-from-hook" },
    }));
    await manager.close();
  });

  test("exposes no builtin resources across the process boundary", async () => {
    const { instances, session, entry } = stores();
    instances.create({
      pluginInstanceId: "process_default",
      pluginId: "tests/process-plugin",
      marketplace: "fixtures",
      packageVersion: "1.0.0",
    });
    const manager = new Manager({
      instances,
      log: entry => session.log(entry),
      harnesses: [
        { id: "codex", harness: "codex" },
        { id: "codex_secondary", harness: "codex" },
      ],
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          namespace: "v1",
          entryUrl: pathToFileURL(entry).href, resourcesUrl: pluginId === "tests/process-plugin" ? new URL("./fixtures/process-definitions.ts", import.meta.url).href : new URL("./fixtures/environment-definitions.ts", import.meta.url).href,
        };
      },
    });
    await manager.start();

    const result = await runProbe(manager, "process_default", PROCESS_TYPE, "no-builtins");
    expect(result).toEqual(["Input", "Output", "Turn", "Session", "Target", "SessionTargetBinding"]);
    await manager.close();
  });

  test("routes deferred Harness output Hook verbs without blocking publication", async () => {
    const outputs: string[] = [];
    const { instances, session, entry } = stores();
    instances.create({
      pluginInstanceId: "process_default",
      pluginId: "tests/process-plugin",
      marketplace: "fixtures",
      packageVersion: "1.0.0",
    });
    const manager = new Manager({
      actions: { "process_default/notify": async (_scope, input) => { const text = (input as { text: string }).text; outputs.push(text); await Bun.sleep(350); return { outputId: `out-${outputs.length}` }; } },
      instances,
      log: entry => session.log(entry),
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          namespace: "v1",
          entryUrl: pathToFileURL(entry).href, resourcesUrl: pluginId === "tests/process-plugin" ? new URL("./fixtures/process-definitions.ts", import.meta.url).href : new URL("./fixtures/environment-definitions.ts", import.meta.url).href,
        };
      },
    });
    await manager.start();

    manager.deferHook("harness.output", { invocationId: "published", kind: "agent_message", harnessName: "codex", eventId: "event", seq: 1 });
    await waitFor(() => outputs.length === 1);
    await manager.settled();
    expect(outputs).toEqual(["Continue outbound publication?"]);
    await manager.close();
    await session.closeLogs();
  });

  test("withdraws registrations after a Runner crash", async () => {
    const outputs: string[] = [];
    const { root, instances, session, entry } = stores();
    session.appendEvent({
      kind: "_aide_invocation_summary",
      source: { type: "aide" },
      harness: "codex",
      harnessName: "codex_default",
      invocationId: "turn_crash",
      payload: {
        invocationId: "turn_crash",
        userText: "test crash while waiting",
        agentText: "ready",
        toolCalls: [],
      },
    });
    instances.create({
      pluginInstanceId: "process_default",
      pluginId: "tests/process-plugin",
      marketplace: "fixtures",
      packageVersion: "1.0.0",
    });
    const activationFailures: unknown[] = [];
    const failures: PluginRunnerFailure[] = [];
    const manager = new Manager({
      actions: { "process_default/notify": async (_scope, input) => { const text = (input as { text: string }).text; outputs.push(text); await Bun.sleep(350); return { outputId: `out-${outputs.length}` }; } },
      instances,
      log: entry => session.log(entry),
      pluginSupervisor: new PluginSupervisor(),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          namespace: "v1",
          entryUrl: pathToFileURL(entry).href, resourcesUrl: pluginId === "tests/process-plugin" ? new URL("./fixtures/process-definitions.ts", import.meta.url).href : new URL("./fixtures/environment-definitions.ts", import.meta.url).href,
        };
      },
      onActivationError(failure) {
        activationFailures.push(failure.error);
      },
      onRunnerFailure(failure) {
        failures.push(failure);
      },
    });

    await manager.start();
    await manager.resourceClient("process_default").create({ apiVersion: "tests.aide.dev/v1alpha1", kind: "Review" }, { name: "turn_crash", spec: {} });
    await waitFor(() => outputs.length === 1);
    await session.flushLogs();
    expect(activationFailures).toEqual([]);
    expect(manager.isInstanceActive("process_default")).toBe(true);
    const activationLog = readFileSync(
      join(session.dir, "harness-runtime.log"),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((record) => record.source === "plugin");
    expect(activationLog).toMatchObject({
      pluginId: "tests/process-plugin",
      pluginInstanceId: "process_default",
      packageVersion: "1.0.0",
      component: "plugin.tests/process-plugin.lifecycle",
      message: "Process Plugin activated",
      attributes: {
        capabilities: ["controllers"],
        runtime: { isolated: true },
      },
    });
    expect(await runProbe(manager, "process_default", PROCESS_TYPE, "data-dirs")).toEqual({
      global: join(root, "plugins", "tests%2Fprocess-plugin"),
      instance: join(root, "plugins", "tests%2Fprocess-plugin", "instances", "process_default"),
    });
    expect(await runProbe(manager, "process_default", PROCESS_TYPE, "resource-ref"))
      .toEqual({ currentUid: expect.stringMatching(/^pr_/) });
    const keys = await runProbe<string[]>(manager, "process_default", PROCESS_TYPE, "execution-context");
    expect(keys).toContain("executionId");
    expect(keys).toContain("verbs");
    expect(keys).not.toContain("session");
    const heartbeat = Bun.sleep(25).then(() => "heartbeat");
    const invocation = runProbe(manager, "process_default", PROCESS_TYPE, "200").then(() => "invocation");
    expect(await Promise.race([heartbeat, invocation])).toBe("heartbeat");
    expect(await invocation).toBe("invocation");
    await expect(runProbe(manager, "process_default", PROCESS_TYPE, "crash")).rejects.toThrow(/Plugin Runner stopped/);
    await waitFor(() => !manager.isInstanceActive("process_default"));
    expect(String(failures[0]?.error)).toMatch(/Plugin Runner (IPC disconnected|exited unexpectedly)/);
    expect(failures).toHaveLength(1);
    expect(session.projection.approvals.size).toBe(0);

    await manager.close();
  });

  test("Controller watchdog terminates a blocked Reconcile while Host remains responsive", async () => {
    const { instances, session, entry } = stores();
    instances.create({ pluginInstanceId: "controller_timeout", pluginId: "tests/process-plugin", marketplace: "fixtures", packageVersion: "1.0.0" });
    const failures: PluginRunnerFailure[] = [];
    const manager = new Manager({ instances, log: entry => session.log(entry),
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) { return { pluginId, version, namespace: "v1", entryUrl: pathToFileURL(entry).href, resourcesUrl: pluginId === "tests/process-plugin" ? new URL("./fixtures/process-definitions.ts", import.meta.url).href : new URL("./fixtures/environment-definitions.ts", import.meta.url).href }; },
      onRunnerFailure(failure) { failures.push(failure); },
    });
    try {
      await manager.start();
      await manager.resourceClient("controller_timeout").create({ apiVersion: "tests.aide.dev/v1alpha1", kind: "ProcessCheck" }, { name: "blocked", spec: { blockMs: 2000 } });
      const completion = manager.settled().then(() => "completed");
      expect(await Promise.race([Bun.sleep(25).then(() => "heartbeat"), completion])).toBe("heartbeat");
      await waitFor(() => failures.length > 0, 2000);
      expect(String(failures[0]!.error)).toMatch(/Controller execution .* timed out/);
      await completion;
      await waitFor(() => !manager.isInstanceActive("controller_timeout"));
    } finally { await manager.close(); }
  });

  test("terminates a Runner whose handler exceeds its deadline", async () => {
    const { instances, session, entry } = stores();
    instances.create({
      pluginInstanceId: "process_timeout",
      pluginId: "tests/process-plugin",
      marketplace: "fixtures",
      packageVersion: "1.0.0",
    });
    const failures: PluginRunnerFailure[] = [];
    const manager = new Manager({
      instances,
      log: entry => session.log(entry),
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          namespace: "v1",
          entryUrl: pathToFileURL(entry).href, resourcesUrl: pluginId === "tests/process-plugin" ? new URL("./fixtures/process-definitions.ts", import.meta.url).href : new URL("./fixtures/environment-definitions.ts", import.meta.url).href,
        };
      },
      onRunnerFailure(failure) {
        failures.push(failure);
      },
    });

    try {
      await manager.start();
      // Hook notifications fail open, but an unresponsive Runner must still be terminated.
      await manager.inlineHook("harness.input", { attemptId: "blocked", harnessName: "codex", invocationId: "blocked-hook", messageId: "message", operation: "new_turn" });
      await waitFor(() => !manager.isInstanceActive("process_timeout"));
      expect(failures).toHaveLength(1);
      expect(String(failures[0]!.error)).toMatch(/Plugin Runner invoke timed out/);
    } finally { await manager.close(); }
  });
});
