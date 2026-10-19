import { resolveEnvironmentConfig } from "../connectors/environments/config.ts";
import { requestResult } from "../src/host/interaction/resolution.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { commandContext, executeCommand } from "./fixtures/command-context.ts";
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

import type {
  DeferredHookStage,
  HookSubjectMap,
  InlineHookStage,
} from "@compforge/aide-plugin";

import { CoreSession } from "../src/host/core/index.ts";
import { PluginInstanceStore } from "../src/host/plugin/instance.ts";
import { Manager, type PluginRunnerFailure } from "../src/host/plugin/manager.ts";
import { PluginSupervisor } from "../src/host/plugin/runner/index.ts";
import {
  restoredError,
  serializedError,
} from "../src/protocol/ipc.ts";
import { SessionHandle } from "../src/host/store/store.ts";

const roots: string[] = [];

function stores() {
  const root = mkdtempSync(join(tmpdir(), "aide-plugin-runner-"));
  roots.push(root);
  const session = {
    id: "bs_runner",
    dir: join(root, "sessions", "bs_runner"),
  };
  const sessionHandle = new SessionHandle(
    session.id,
    session.dir,
    {
      aideSessionId: session.id,
      cwd: root,
      createdAt: new Date().toISOString(),
      harnessTargets: {},
      lanes: {
        main: {
          laneId: "main",
          createdFor: { type: "session" },
          harnessSessions: {},
        },
      },
      harnessSessions: {},
    },
  );
  mkdirSync(session.dir, { recursive: true });
  const packageDir = join(root, "installed-package");
  const entry = join(packageDir, "index.ts");
  mkdirSync(packageDir, { recursive: true });
  // Installed Marketplace Packages have no node_modules. Type-only imports
  // must erase cleanly instead of resolving through Aide's dependency tree.
  cpSync(join(import.meta.dir, "fixtures", "process-plugin.ts"), entry);
  return {
    root,
    instances: new PluginInstanceStore({ session }),
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
    const identity = { forge: "forge", path: "org/repo", number: 1 };
    const pull = { identity, title: "Shared PR", url: "https://example.com/1", lifecycle: "open" as const,
      reviewThreads: "none" as const, mergeability: "ready" as const, observedAt: "2026-10-19T00:00:00Z" };
    let reads = 0;
    const connectors = new Connectors([{
      source: "work", provider: "fixture", async list() { reads++; return [requirement]; }, async get() { return requirement; },
    }], [{
      forge: "forge", provider: "github", async list() { return [identity]; }, async get() { return pull; }, async comments() { return []; },
    }], new Environments(resolveEnvironmentConfig({ dev: { kind: "host", aliases: ["开发"], host: { name: "vm", transport: "ssh", address: "not-contacted.invalid" } } })));
    const failures: unknown[] = [];
    const manager = new Manager({
      instances, session, connectors, pluginSupervisor: new PluginSupervisor(),
      onActivationError: ({ error }) => { failures.push(error); },
      async loadPackageEntry(pluginId, version) { return { pluginId, version, entryUrl: pathToFileURL(entry).href }; },
    });
    try {
      await manager.start();
      expect(failures).toEqual([]);
      for (const id of ["first", "second"]) {
        expect(manager.isInstanceActive(id)).toBe(true);
        const response = await executeCommand(manager, `environment-${id}`, { argument: "" });
        if (response?.kind !== "message") throw new Error("Expected connector result");
        expect(JSON.parse(response.text)).toMatchObject({
          environment: { name: "dev", host: { address: "not-contacted.invalid" } },
          catalog: { requirements: [{ source: "work", provider: "fixture" }], forges: [{ forge: "forge", provider: "github" }] },
          requirements: [requirement], requirement, pulls: [identity], pull, comments: [],
        });
        await expect(executeCommand(manager, `environment-${id}`, { argument: "missing" })).rejects.toThrow("Unknown environment: missing");
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
    const { instances, session, entry } = stores();
    session.appendEvent({
      kind: "_aide_turn_summary",
      source: { type: "aide" },
      harness: "codex",
      harnessTargetId: "codex_default",
      turnId: "turn_runner",
      payload: {
        turnId: "turn_runner",
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
      instances,
      session,
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          namespace: "v1",
          entryUrl: pathToFileURL(entry).href,
        };
      },
    });

    await manager.start();
    await waitFor(() => session.loadState().interactions.size === 1, 1_000);
    expect([...session.loadState().interactions.values()][0]).toMatchObject({
      request: {
        source: {
          kind: "plugin",
          key: "process_default",
        },
        request: { questions: [{
          header: "Runner question",
          question: "Review turn_runner?",
        }] },
      },
    });
    await Bun.sleep(300);
    expect(manager.isInstanceActive("process_default")).toBe(true);
    const interaction = [...session.loadState().interactions.values()][0]!
      .request;
    expect(await manager.completeInteraction(interaction.messageId, {
      kind: "question",
      outcome: "answered",
      answers: { decision: ["continue"] },
    })).toBe(true);
    await waitFor(() =>
      requestResult(session.loadState(), interaction.messageId) !==
        undefined
    );

    await manager.close();
  });

  test("routes Hook notifications and verbs across the process boundary", async () => {
    const { instances, session, entry } = stores();
    instances.create({
      pluginInstanceId: "process_default",
      pluginId: "tests/process-plugin",
      marketplace: "fixtures",
      packageVersion: "1.0.0",
    });
    const manager = new Manager({
      instances,
      session,
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          namespace: "v1",
          entryUrl: pathToFileURL(entry).href,
        };
      },
    });
    await manager.start();

    const notification = manager.inlineHook("view.input", {
      inputId: "in_runner_hook",
      eventId: "ev_runner_hook",
      seq: 1,
      input: { kind: "prompt", text: "ask from hook", harnessTargetId: "codex" },
    });
    await waitFor(() => session.loadState().interactions.size === 1);
    await Bun.sleep(300);
    expect(manager.isInstanceActive("process_default")).toBe(true);
    const interaction = [...session.loadState().interactions.values()][0]!
      .request;
    expect(interaction.request.kind).toBe("question");
    if (interaction.request.kind !== "question") throw new Error("expected a question");
    expect(interaction.request.questions[0]).toMatchObject({
      header: "Hook question",
      question: "Continue from Hook?",
    });
    expect(await manager.completeInteraction(interaction.messageId, {
      kind: "question",
      outcome: "answered",
      answers: { decision: ["continue"] },
    })).toBe(true);
    await expect(notification).resolves.toBeUndefined();

    await session.flushLogs();
    const records = readFileSync(join(session.dir, "session.log"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toContainEqual(expect.objectContaining({
      source: "plugin",
      component: "plugin.tests/process-plugin.hook",
      message: "Process Hook observed input",
      attributes: { inputId: "in_runner_hook" },
    }));
    await manager.close();
  });

  test("routes Core Resource reads and patch across the process boundary", async () => {
    const { instances, session, entry } = stores();
    instances.create({
      pluginInstanceId: "process_default",
      pluginId: "tests/process-plugin",
      marketplace: "fixtures",
      packageVersion: "1.0.0",
    });
    const manager = new Manager({
      instances,
      session,
      harnessTargets: [
        { id: "codex", harness: "codex" },
        { id: "codex_secondary", harness: "codex" },
      ],
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          namespace: "v1",
          entryUrl: pathToFileURL(entry).href,
        };
      },
    });
    await manager.start();

    await manager.inlineHook("view.input", {
      inputId: "in_runner_resource",
      eventId: "ev_runner_resource",
      seq: 1,
      input: {
        kind: "prompt",
        text: "route from hook",
        harnessTargetId: "codex",
      },
    });

    expect(manager.resolveHarnessTargetId("codex")).toBe("codex_secondary");
    await manager.close();
  });

  test("routes deferred ViewOutput Hook verbs without blocking publication", async () => {
    const { instances, session, entry } = stores();
    instances.create({
      pluginInstanceId: "process_default",
      pluginId: "tests/process-plugin",
      marketplace: "fixtures",
      packageVersion: "1.0.0",
    });
    const manager = new Manager({
      instances,
      session,
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          namespace: "v1",
          entryUrl: pathToFileURL(entry).href,
        };
      },
    });
    await manager.start();

    const outputKinds: string[] = [];
    const channel = new CoreSession({
      session,
      controller: {
        mentionBudgetChars: 1_000,
        createAdapter: () => {
          throw new Error("unused test adapter");
        },
        resolveTarget: () => undefined,
      },
      hooks: {
        has: (stage) => manager.hasHook(stage),
        inline: async <S extends InlineHookStage>(
          stage: S,
          subject: Readonly<HookSubjectMap[S]>,
        ) => await manager.inlineHook(stage, subject),
        defer: <S extends DeferredHookStage>(
          stage: S,
          subject: Readonly<HookSubjectMap[S]>,
        ) => {
          if (stage === "view.output") {
            outputKinds.push((
              subject as unknown as HookSubjectMap["view.output"]
            ).kind);
          }
          manager.deferHook(stage, subject);
        },
      },
    });
    const unsubscribe = session.subscribe((event) => {
      if (event.kind !== "interaction.requested") return;
      void channel.publishViewOutput("interaction", () => true);
    });

    await expect(channel.publishViewOutput("transcript", () => true)).resolves.toBe(true);
    await waitFor(() => session.loadState().interactions.size === 1, 1_000);
    const interaction = [...session.loadState().interactions.values()][0]!
      .request;
    expect(await manager.completeInteraction(interaction.messageId, {
      kind: "question",
      outcome: "answered",
      answers: { decision: ["continue"] },
    })).toBe(true);
    unsubscribe();
    await manager.close();
    await channel.close();
    expect(outputKinds).toEqual(["transcript", "interaction"]);
  });

  test("withdraws registrations and settles a waiting verb after a crash", async () => {
    const { root, instances, session, entry } = stores();
    session.appendEvent({
      kind: "_aide_turn_summary",
      source: { type: "aide" },
      harness: "codex",
      harnessTargetId: "codex_default",
      turnId: "turn_crash",
      payload: {
        turnId: "turn_crash",
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
      instances,
      session,
      pluginSupervisor: new PluginSupervisor(),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          namespace: "v1",
          entryUrl: pathToFileURL(entry).href,
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
    await waitFor(() => session.loadState().interactions.size === 1);
    await session.flushLogs();
    expect(activationFailures).toEqual([]);
    expect(manager.isInstanceActive("process_default")).toBe(true);
    const activationLog = readFileSync(
      join(session.dir, "session.log"),
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
        capabilities: ["commands"],
        runtime: { isolated: true },
      },
    });
    await expect(
      executeCommand(manager, "process-check", { argument: "data-dirs" }),
    ).resolves.toEqual({
      kind: "message",
      text: JSON.stringify({
        global: join(root, "plugins", "tests%2Fprocess-plugin"),
        session: join(
          root,
          "sessions",
          "bs_runner",
          "plugins",
          "tests%2Fprocess-plugin",
        ),
        instance: join(
          root,
          "sessions",
          "bs_runner",
          "plugins",
          "tests%2Fprocess-plugin",
          "process_default",
        ),
      }),
    });
    await expect(
      executeCommand(manager, "process-check", { argument: "resource-ref" }),
    ).resolves.toEqual({
      kind: "message",
      text: expect.stringMatching(
        /^\{"currentUid":"pr_[^"]+"\}$/,
      ),
    });
    const submitted: unknown[] = [];
    const configurations: unknown[] = [];
    const command = commandContext("tests/process-plugin", "process-check");
    const submitReceipt = { messageId: "m_command", turnId: "t_command", queued: true };
    expect(await manager.executeCommand("process-check", { argument: "submit" }, {
      ...command, target: { id: "codex2", harness: "codex" },
      verbs: {
        async submit(input) { submitted.push(input); return submitReceipt; },
        async configureModel(input) { configurations.push(input); },
      },
    })).toEqual({ kind: "message", text: JSON.stringify({
      command: command.command, target: { id: "codex2", harness: "codex" }, receipt: submitReceipt,
    }) });
    expect(submitted).toEqual([{ prompt: "task" }]);
    expect(configurations).toEqual([{ model: "fast", effort: "medium" }]);
    const heartbeat = Bun.sleep(25).then(() => "heartbeat");
    const invocation = executeCommand(manager, "process-check", {
      argument: "200",
    }).then(() => "invocation");
    expect(await Promise.race([heartbeat, invocation])).toBe("heartbeat");
    expect(await invocation).toBe("invocation");

    await expect(
      executeCommand(manager, "process-check", { argument: "crash" }),
    ).rejects.toThrow(/Plugin Runner (IPC disconnected|exited unexpectedly)/);
    await waitFor(() => !manager.isInstanceActive("process_default"));
    expect(manager.listCommands()).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(requestResult(session.projection, [...session.projection.interactions.keys()][0]!)).toMatchObject({
      kind: "cancelled",
      reason: "recovery",
    });

    await manager.close();
  });

  test("Controller watchdog terminates a blocked Reconcile while Host remains responsive", async () => {
    const { instances, session, entry } = stores();
    instances.create({ pluginInstanceId: "controller_timeout", pluginId: "tests/process-plugin", marketplace: "fixtures", packageVersion: "1.0.0" });
    const failures: PluginRunnerFailure[] = [];
    const manager = new Manager({ instances, session,
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) { return { pluginId, version, namespace: "v1", entryUrl: pathToFileURL(entry).href }; },
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
      session,
      pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 250 }),
      async loadPackageEntry(pluginId, version) {
        return {
          pluginId,
          version,
          namespace: "v1",
          entryUrl: pathToFileURL(entry).href,
        };
      },
      onRunnerFailure(failure) {
        failures.push(failure);
      },
    });

    await manager.start();
    await expect(
      executeCommand(manager, "process-check", { argument: "2000" }),
    ).rejects.toThrow(/Plugin Runner invoke timed out/);
    await waitFor(() => !manager.isInstanceActive("process_timeout"));
    expect(manager.listCommands()).toEqual([]);
    expect(failures).toHaveLength(1);

    await manager.close();
  });
});
import { Connectors } from "../connectors/index.ts";
import { Environments } from "../connectors/environments.ts";
