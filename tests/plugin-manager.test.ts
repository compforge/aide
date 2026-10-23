import { HarnessCalls } from "../src/host/harness/calls.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ReconcileKey,
  ReconcileScope,
} from "../src/host/plugin/controller.ts";
import { emptyReconcileSnapshot } from "../src/host/plugin/reconcile-snapshot.ts";
import { Manager } from "../src/host/plugin/manager.ts";
import { PluginInstanceStore } from "../src/host/plugin/instance.ts";
import { PluginResourceStore as BaseResourceStore, type PluginResourceStoreOptions } from "../src/host/plugin/resource/store.ts";
import { definition } from "./fixtures/resource-definition.ts";
import type { ScheduledHarnessInvocation } from "../src/host/harness/invocation.ts";
import { HarnessFixtures } from "./harness-fixture.ts";

interface Spec {
  value: string;
}

const roots: string[] = [];
const API_VERSION = "tests.aide.dev/v1alpha1";

function resourceType(kind: string) {
  return { apiVersion: API_VERSION, kind };
}

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aide-plugin-manager-"));
  roots.push(root);
  return root;
}

function scope(pluginInstanceId: string, resourceKind: string = "Requirement"): ReconcileScope {
  return {

    pluginInstanceId,
    namespace: "v1",
    resourceApiVersion: API_VERSION,
    resourceKind,
  };
}

function key(
  pluginInstanceId: string,
  resourceId: string,
  resourceKind: string = "Requirement",
): ReconcileKey {
  return {
    ...scope(pluginInstanceId, resourceKind),
    resourceId,
  };
}

function store(root: string, pluginInstanceId: string): PluginResourceStore {
  return new PluginResourceStore({
    home: root,
    pluginInstanceId,
  });
}

function instanceStore(root: string): PluginInstanceStore {
  return new PluginInstanceStore({
    home: root,
  });
}

function createResource(
  resources: PluginResourceStore,
  resourceKind: string,
  resourceId: string,
): void {
  resources.create<Spec>({
    type: resourceType(resourceKind),
    name: resourceId,
    spec: { value: resourceId },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, timeoutMs: number = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("plugin Manager", () => {
  test("awaits resource-owned Harness execution and returns its result", async () => {
    const root = testRoot();
    const session = new HarnessFixtures(root).create({ cwd: "/repo" });
    const resources = new PluginResourceStore({
      home: session.home,
      pluginInstanceId: "reqloop_default",
    });
    resources.create<Spec>({
      type: resourceType("Requirement"),
      name: "run_1",
      spec: { value: "run_1" },
    });
    const states: string[] = [];
    const scheduled: ScheduledHarnessInvocation[] = [];
    let defaultHarnessConfigurationId = "claude";
    const manager = new Manager({
      instances: new PluginInstanceStore({ home: session.home }),
      snapshot() {
        return {
          ...emptyReconcileSnapshot(),
          harnesses: [
            { id: "codex", harness: "codex" },
            { id: "claude", harness: "claude" },
          ],
        };
      },
      harness: new HarnessCalls({ records: session, harnesses: () => [{ id: "codex" }, { id: "claude" }],
        get defaultHarness() { return defaultHarnessConfigurationId; },
        enqueueHarnessInvocation(request) { scheduled.push(request); },
      }),
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx) {
        const result = await ctx.verbs.harness({
          title: "Implement",
          prompt: "Implement run_1.",
          timeoutMs: 1_000,
        });
        states.push(
          result.state === "success"
            ? `${result.state}:${result.value.outcome}`
            : result.state,
        );
      },
    });
    const reconcileKey = {
      pluginInstanceId: "reqloop_default",
      namespace: "v1" as const,
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId: "run_1",
    };

    const reconcile = manager.enqueue(reconcileKey);
    await waitFor(() => scheduled.length === 1);
    expect(scheduled[0]).toMatchObject({
      harnessName: "claude",
      blocks: [{ type: "text", text: "Implement run_1." }],
      source: "plugin",
    });
    expect(scheduled[0]?.runtimeId).toBeTruthy();
    expect(session.projection.approvals.size).toBe(0);
    expect(session.events.filter((event) =>
      event.kind === "approval.requested" ||
      event.kind === "approval.answered" ||
      event.kind === "_aide_harness_invocation_recorded" ||
      event.kind === "_aide_harness_invocation_scheduled"
    ).map((event) => event.kind)).toEqual([
      "_aide_harness_invocation_recorded",
      "_aide_harness_invocation_scheduled",
    ]);
    expect(states).toEqual([]);
    defaultHarnessConfigurationId = "codex";

    const input = scheduled[0]!;
    session.appendEvent({
      kind: "user_message",
      source: {
        type: "plugin",
        pluginInstanceId: "reqloop_default",
      },
      harness: "claude",
      harnessName: input.harnessName,
      invocationId: input.invocationId,
      payload: {
        messageId: input.messageId,
        content: [...input.blocks],
      },
    });
    session.appendEvent({
      kind: "_aide_invocation_summary",
      source: { type: "aide" },
      harness: "claude",
      harnessName: input.harnessName,
      invocationId: input.invocationId,
      payload: {
        invocationId: input.invocationId,
        stopReason: "end_turn",
        agentText: "Implemented.",
        toolCalls: [],
      },
    });
    await reconcile;
    expect(states).toEqual(["success:completed"]);
    expect(manager.listHarnessInvocations()[0]).toMatchObject({
      phase: "completed",
      result: { agentText: "Implemented." },
    });
    expect(scheduled).toHaveLength(1);
    await manager.close();
  });

  test("returns dismissed when the user cancels ctx.harness", async () => {
    const root = testRoot();
    const session = new HarnessFixtures(root).create({ cwd: "/repo" });
    const resources = new PluginResourceStore({
      home: session.home,
      pluginInstanceId: "reqloop_default",
    });
    resources.create<Spec>({
      type: resourceType("Requirement"),
      name: "run_1",
      spec: { value: "run_1" },
    });
    const states: string[] = [];
    const manager = new Manager({
      instances: new PluginInstanceStore({ home: session.home }),
      snapshot: () => ({
        ...emptyReconcileSnapshot(),
        harnesses: [{ id: "codex", harness: "codex" }],
      }),
      harness: new HarnessCalls({ records: session, harnesses: () => [{ id: "codex" }],
        defaultHarness: "codex", enqueueHarnessInvocation() {},
      }),
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(ctx) {
        const result = await ctx.verbs.harness({
          title: "Implement",
          prompt: "Implement run_1.",
          timeoutMs: 1_000,
        });
        states.push(result.state);
      },
    });

    const reconcileKey = {
      pluginInstanceId: "reqloop_default",
      namespace: "v1" as const,
      resourceApiVersion: API_VERSION,
      resourceKind: "Requirement",
      resourceId: "run_1",
    };
    const reconcile = manager.enqueue(reconcileKey);
    await waitFor(() => manager.listHarnessInvocations().length === 1);
    const invocationId = manager.listHarnessInvocations()[0]!.invocationId;
    expect(await manager.cancelHarnessInvocation(invocationId)).toBe(true);
    expect(manager.listHarnessInvocations()[0]).toMatchObject({
      phase: "cancelled",
      cancellation: { reason: "user" },
    });
    await reconcile;
    expect(states).toEqual(["dismissed"]);
    await manager.close();
  });

  test("routes many Plugin instances through one globally bounded capacity", async () => {
    const root = testRoot();
    const reqloopStore = store(root, "reqloop_default");
    const deployStore = store(root, "deploy_default");
    createResource(reqloopStore, "Requirement", "run_1");
    createResource(deployStore, "Deployment", "deployment_1");
    const gate = deferred();
    const started: string[] = [];
    const manager = new Manager({
      maxTotalConcurrency: 1,
      instances: instanceStore(root),
    });
    manager.registerController<Spec, Record<string, never>>({
      store: reqloopStore,
      resourceType: resourceType("Requirement"),
      async reconcile() {
          started.push("reqloop_default");
          await gate.promise;
          return;
        },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: deployStore,
      resourceType: resourceType("Deployment"),
      async reconcile() {
          started.push("deploy_default");
        },
    });

    const first = manager.enqueue(key("reqloop_default", "run_1"));
    const second = manager.enqueue(key("deploy_default", "deployment_1", "Deployment"));
    await Promise.resolve();
    expect(started).toEqual(["reqloop_default"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(started).toEqual(["reqloop_default", "deploy_default"]);
  });

  test("rejects duplicate scopes and an unregistered route", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    const definition = {
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {},
    };
    const manager = new Manager({ instances: instanceStore(root) });
    manager.registerController(definition);

    expect(() => manager.registerController(definition)).toThrow(
      `plugin Controller already registered for reqloop_default/v1/${API_VERSION}/Requirement`,
    );
    await expect(manager.enqueue(key("missing", "run_1"))).rejects.toThrow(
      `no plugin Controller registered for missing/v1/${API_VERSION}/Requirement`,
    );
  });

  test("routes descendant namespace keys to a global Plugin Controller", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    resources.create<Spec>({
      type: resourceType("Requirement"),
      name: "run_1",
      namespace: "v1/project/project-a",
      spec: { value: "run_1" },
    });
    const reconciled: string[] = [];
    const manager = new Manager({ instances: instanceStore(root) });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(_context, resource) {
        reconciled.push(resource.metadata.namespace);
      },
    });

    await manager.enqueue({
      ...key("reqloop_default", "run_1"),
      namespace: "v1/project/project-a",
    });
    expect(reconciled).toEqual(["v1/project/project-a"]);
    await manager.close();
  });

  test("registration close is idempotent and removes only its Controller", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    const manager = new Manager({ instances: instanceStore(root) });
    const registration = manager.registerController({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {},
    });

    await expect(manager.enqueue(key("reqloop_default", "run_1"))).resolves.toBeUndefined();
    registration.close();
    registration.close();
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      `no plugin Controller registered for reqloop_default/v1/${API_VERSION}/Requirement`,
    );
  });

  test("registration close prevents work still waiting for global capacity", async () => {
    const root = testRoot();
    const firstStore = store(root, "reqloop_default");
    const waitingStore = store(root, "deploy_default");
    createResource(firstStore, "Requirement", "run_1");
    createResource(waitingStore, "Deployment", "deployment_1");
    const gate = deferred();
    let waitingRuns = 0;
    const manager = new Manager({
      maxTotalConcurrency: 1,
      instances: instanceStore(root),
    });
    manager.registerController<Spec, Record<string, never>>({
      store: firstStore,
      resourceType: resourceType("Requirement"),
      async reconcile() {
          await gate.promise;
        },
    });
    const waitingRegistration = manager.registerController<Spec, Record<string, never>>({
      store: waitingStore,
      resourceType: resourceType("Deployment"),
      async reconcile() {
          waitingRuns += 1;
        },
    });

    const running = manager.enqueue(key("reqloop_default", "run_1"));
    const waiting = manager.enqueue(
      key("deploy_default", "deployment_1", "Deployment"),
    );
    await Promise.resolve();
    waitingRegistration.close();
    const waitingResult = waiting.then(
      () => undefined,
      (error: unknown) => error,
    );
    gate.resolve();

    await expect(running).resolves.toBeUndefined();
    const waitingError = await waitingResult;
    expect(waitingError).toBeInstanceOf(Error);
    expect((waitingError as Error).message).toBe("plugin Controller is closed");
    expect(waitingRuns).toBe(0);
  });

  test("keeps per-Controller concurrency independent under the global limit", async () => {
    const root = testRoot();
    const reqloopStore = store(root, "reqloop_default");
    const deployStore = store(root, "deploy_default");
    createResource(reqloopStore, "Requirement", "run_1");
    createResource(reqloopStore, "Requirement", "run_2");
    createResource(deployStore, "Deployment", "deployment_1");
    const gate = deferred();
    const started: string[] = [];
    const manager = new Manager({
      maxTotalConcurrency: 2,
      instances: instanceStore(root),
    });
    manager.registerController<Spec, Record<string, never>>({
      store: reqloopStore,
      resourceType: resourceType("Requirement"),
      maxConcurrency: 1,
      async reconcile(_ctx, resource) {
          started.push(
            `reqloop_default/${resource.metadata.name}`,
          );
          await gate.promise;
        },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: deployStore,
      resourceType: resourceType("Deployment"),
      maxConcurrency: 1,
      async reconcile(_ctx, resource) {
          started.push(
            `deploy_default/${resource.metadata.name}`,
          );
          await gate.promise;
        },
    });

    const reqloopFirst = manager.enqueue(key("reqloop_default", "run_1"));
    const reqloopSecond = manager.enqueue(key("reqloop_default", "run_2"));
    const deployment = manager.enqueue(
      key("deploy_default", "deployment_1", "Deployment"),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([
      "reqloop_default/run_1",
      "deploy_default/deployment_1",
    ]);

    gate.resolve();
    await Promise.all([reqloopFirst, reqloopSecond, deployment]);
    expect(started).toEqual([
      "reqloop_default/run_1",
      "deploy_default/deployment_1",
      "reqloop_default/run_2",
    ]);
  });

  test("validates total capacity", () => {
    const root = testRoot();
    expect(
      () =>
        new Manager({
          maxTotalConcurrency: 0,
          instances: instanceStore(root),
        }),
    ).toThrow(
      "maxTotalConcurrency must be a positive integer",
    );
    expect(
      () =>
        new Manager({
          instances: instanceStore(root),
          retryBackoff: { initialDelayMs: 0 },
        }),
    ).toThrow("retryBackoff.initialDelayMs must be a positive integer");
    expect(
      () =>
        new Manager({
          instances: instanceStore(root),
          retryBackoff: { initialDelayMs: 20, maxDelayMs: 10 },
        }),
    ).toThrow("retryBackoff.maxDelayMs must be at least initialDelayMs");
  });

  test("restores expired and future reconcile times when the Manager starts", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "expired");
    createResource(resources, "Requirement", "future");
    const now = Date.now();
    resources.setNextReconcileAt(resourceType("Requirement"), "expired", new Date(now - 1_000));
    resources.setNextReconcileAt(resourceType("Requirement"), "future", new Date(now + 100));
    const runs: string[] = [];
    const manager = new Manager({
      instances: instanceStore(root),
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile(_ctx, resource) {
          runs.push(resource.metadata.name);
        },
    });

    await manager.start();
    await waitFor(() => runs.includes("expired"));
    expect(runs).toEqual(["expired"]);
    await waitFor(() => runs.includes("future"));
    expect(runs).toEqual(["expired", "future"]);
    expect(resources.scheduledReconciles(resourceType("Requirement"))).toEqual([]);
    registration.close();
  });

  test("turns requeueAfter into another reconcile and replaces the persisted due time", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    let runs = 0;
    const manager = new Manager({
      instances: instanceStore(root),
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {
          runs += 1;
          if (runs === 1) return { requeueAfterMs: 20 };
        },
    });

    await manager.start();
    expect(resources.scheduledReconciles(resourceType("Requirement"))).toHaveLength(1);
    await waitFor(() => runs === 2);
    expect(resources.scheduledReconciles(resourceType("Requirement"))).toEqual([]);
    registration.close();
  });

  test("cron Sources enqueue every current Resource through the keyed queue", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    createResource(resources, "Requirement", "run_2");
    let now = new Date("2026-07-26T00:00:00.990Z");
    const runs: string[] = [];
    const manager = new Manager({
      instances: instanceStore(root),
      now: () => now,
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      sources: [
        {
          type: "cron",
          sourceId: "poll-pr-state",
          cron: "* * * * * *",
          timeZone: "UTC",
        },
        {
          type: "cron",
          sourceId: "poll-requirement-state",
          cron: "* * * * * *",
          timeZone: "UTC",
        },
      ],
      async reconcile(_ctx, resource) {
          runs.push(resource.metadata.name);
        },
    });

    await manager.start();
    // Controller 启动会先 reconcile 现有 Resource；清空这批结果后再单独观察 cron tick，
    // 避免首次 reconcile 与 timer 同时完成时 runs 从 0 直接越过 2。
    await waitFor(() => runs.length === 2);
    runs.length = 0;
    now = new Date("2026-07-26T00:00:01.000Z");
    await waitFor(() => runs.length === 2);
    expect(runs.sort()).toEqual(["run_1", "run_2"]);
    expect(
      resources.scheduledReconciles(resourceType("Requirement")).length === 0,
    ).toBe(true);

    registration.close();
    await manager.close();
  });

  test("resource Sources finish initial sync before reconciling discovered Resources", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    const ready = deferred();
    const runs: string[] = [];
    const failures: string[] = [];
    let emit!: (resource: { name: string; spec: Spec }) => void;
    let sourceSignal!: { readonly aborted: boolean };
    const manager = new Manager({
      instances: instanceStore(root),
      onControllerSourceError(failure) {
        failures.push(failure.sourceId);
      },
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      sources: [{
        type: "resource",
        sourceId: "discover-pr",
        async start(context) {
          emit = context.emit;
          sourceSignal = context.signal;
          context.emit({
            name: "run_discovered",
            spec: { value: "run_discovered" },
          });
          await ready.promise;
        },
      }],
      async reconcile(_ctx, resource) {
        runs.push(resource.metadata.name);
      },
    });

    const starting = manager.start();
    await Bun.sleep(20);
    expect(runs).toEqual([]);
    ready.resolve();
    await starting;
    await waitFor(() => runs.length === 1);
    expect(runs).toEqual(["run_discovered"]);

    emit({
      name: "run_discovered",
      spec: { value: "run_discovered" },
    });
    await waitFor(() => runs.length === 2);
    expect(runs).toEqual(["run_discovered", "run_discovered"]);

    emit({
      name: "run_discovered",
      spec: { value: "different" },
    });
    await waitFor(() => failures.length === 1);
    expect(failures).toEqual(["discover-pr"]);
    expect(resources.get<Spec>(
      resourceType("Requirement"),
      "run_discovered",
    ).spec).toEqual({ value: "run_discovered" });

    registration.close();
    expect(sourceSignal.aborted).toBe(true);
    await manager.close();
  });

  test("resource Source startup failure does not block known Resources", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_known");
    const failures: string[] = [];
    const runs: string[] = [];
    const manager = new Manager({
      instances: instanceStore(root),
      onControllerSourceError(failure) {
        failures.push(failure.sourceId);
      },
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      sources: [{
        type: "resource",
        sourceId: "discover-pr",
        start() {
          throw new Error("forge unavailable");
        },
      }],
      async reconcile(_ctx, resource) {
        runs.push(resource.metadata.name);
      },
    });

    await manager.start();
    expect(failures).toEqual(["discover-pr"]);
    await waitFor(() => runs.length === 1);
    expect(runs).toEqual(["run_known"]);

    registration.close();
    await manager.close();
  });

  test("stops cron Sources when their Controller registration closes", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    let now = new Date("2026-07-26T00:00:00.990Z");
    let runs = 0;
    const manager = new Manager({
      instances: instanceStore(root),
      now: () => now,
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      sources: [{
        type: "cron",
        sourceId: "poll-pr-state",
        cron: "* * * * * *",
        timeZone: "UTC",
      }],
      async reconcile() {
          runs += 1;
        },
    });

    await manager.start();
    registration.close();
    now = new Date("2026-07-26T00:00:01.000Z");
    await Bun.sleep(30);
    expect(runs).toBe(1);
    await manager.close();
  });

  test("persists error backoff so another Manager can recover the retry", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    const failures: Array<{ attempt: number; nextRetryAt?: string }> = [];
    const firstManager = new Manager({
      instances: instanceStore(root),
      retryBackoff: { initialDelayMs: 30, maxDelayMs: 60 },
      onReconcileError(failure) {
        failures.push({
          attempt: failure.attempt,
          nextRetryAt: failure.nextRetryAt,
        });
      },
    });
    const firstRegistration = firstManager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {
          throw new Error("connector unavailable");
        },
    });

    await expect(firstManager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "connector unavailable",
    );
    expect(failures).toEqual([{ attempt: 1, nextRetryAt: expect.any(String) }]);
    expect(
      resources.scheduledReconciles(resourceType("Requirement"))[0]
        ?.nextReconcileAt.toISOString(),
    ).toBe(failures[0]?.nextRetryAt);
    firstRegistration.close();

    let recoveredRuns = 0;
    const recoveredManager = new Manager({
      instances: instanceStore(root),
    });
    const recoveredRegistration = recoveredManager.registerController<
      Spec,
      Record<string, never>
    >({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {
          recoveredRuns += 1;
        },
    });
    await recoveredManager.start();
    await waitFor(() => recoveredRuns === 1);
    expect(resources.scheduledReconciles(resourceType("Requirement"))).toEqual([]);
    recoveredRegistration.close();
  });

  test("backs off repeated failures per key and resets the attempt after success", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    let runs = 0;
    let failNext = false;
    const attempts: number[] = [];
    const manager = new Manager({
      instances: instanceStore(root),
      retryBackoff: { initialDelayMs: 10, maxDelayMs: 20 },
      onReconcileError(failure) {
        attempts.push(failure.attempt);
      },
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {
          runs += 1;
          if (runs <= 2 || failNext) {
            failNext = false;
            throw new Error("transient connector failure");
          }
        },
    });

    await manager.start();
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "transient connector failure",
    );
    await waitFor(() => runs === 3);
    expect(attempts).toEqual([1, 2]);

    failNext = true;
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "transient connector failure",
    );
    expect(attempts).toEqual([1, 2, 1]);
    await waitFor(() => runs === 5);
    registration.close();
  });

  test("registration close cancels its future reconcile wake-ups", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "Requirement", "run_1");
    let runs = 0;
    const manager = new Manager({
      instances: instanceStore(root),
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceType: resourceType("Requirement"),
      async reconcile() {
        runs += 1;
        return { requeueAfterMs: 50 };
      },
    });

    await manager.start();
    registration.close();
    await Bun.sleep(80);
    expect(runs).toBe(1);
  });
});

const testDefinitions = [definition({ apiVersion: "tests.aide.dev/v1alpha1", kind: "Requirement" }), definition({ apiVersion: "tests.aide.dev/v1alpha1", kind: "Deployment" })];
class PluginResourceStore extends BaseResourceStore {
  constructor(options: PluginResourceStoreOptions) { super(options); this.storage.register(options.pluginInstanceId, testDefinitions); }
}
