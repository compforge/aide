import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { PluginPackage, ResourceDefinition } from "@compforge/aide-plugin";
import { ApplicationRuntime } from "../src/host/runtime/index.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { resourceExecutionKey } from "../src/host/plugin/execution-context.ts";
import { assertResourceUid } from "../src/host/plugin/resource/type.ts";

const TYPE = { apiVersion: "example.dev/v1", kind: "Document" };
const definition: ResourceDefinition = {
  type: TYPE, schema: {
    spec: z.object({ text: z.string() }).strict(),
    status: z.object({ reconciled: z.boolean().default(false) }).strict(),
  },
};
function home(t: { after(fn: () => void): void }) {
  const path = mkdtempSync(join(tmpdir(), "aide-runtime-"));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Runtime did not reconcile the shared resource");
    await Bun.sleep(10);
  }
}

/** @case A non-Personal plugin schedules shared resource changes without a transport Session or builtin resource. */
test("Application runtime reconciles generic shared resources and metadata without Personal", async (t) => {
  const root = home(t);
  const failures: unknown[] = [];
  const seen: Array<string | undefined> = [];
  const plugin: PluginPackage = {
    pluginId: "example", version: "1.0.0", resources: [definition],
    async activate(context) {
      assert.equal("session" in context, false);
      assert.equal("aideSessionId" in context.instance, false);
      assert.deepEqual(Object.keys(context.dataDirs).sort(), ["global", "instance"]);
      context.controllers.register({ resourceType: TYPE, async reconcile(_execution, resource) {
        seen.push(resource.metadata.labels?.phase);
        await context.resources.patchStatus(resource, { reconciled: true });
      } });
    },
  };
  const options = {
    cwd: root, targets: [], instances: [{ pluginInstanceId: "example", pluginId: "example", packageVersion: "1.0.0", config: {} }],
    controller: { mentionBudgetChars: 0, createAdapter: () => { throw new Error("No Harness requested"); } },
    plugins: { packages: [plugin], onActivationError: ({ error }: { error: unknown }) => { failures.push(error); } },
  };
  let runtime = new ApplicationRuntime(root, options);
  t.after(async () => { await runtime.close(); });
  await runtime.start();
  assert.deepEqual(failures, []);
  assert.equal(existsSync(join(root, "sessions")), false);
  assert.equal(runtime.plugins.isInstanceActive("example"), true);
  const client = runtime.plugins.resourceClient("example");
  for (const kind of ["Input", "Output", "Turn", "Session", "Target"]) {
    await assert.rejects(client.list({ apiVersion: "aide.dev/v1alpha1", kind }), /Unknown resource definition/);
  }
  // Independent API clients must trigger the same controller through committed storage writes.
  const external = createResourceClient(new PluginResourceStore({ home: root, pluginInstanceId: "example" }));
  const created = await external.create(TYPE, { name: "topic/with:opaque-id", spec: { text: "hello" } });
  await waitFor(() => seen.length === 1);
  const ref = { ...TYPE, name: created.metadata.name, namespace: created.metadata.namespace, uid: created.metadata.uid };
  await waitFor(() => new PluginResourceStore({ home: root, pluginInstanceId: "example" }).get<{ text: string }, { reconciled: boolean }>(TYPE, ref.name).status.reconciled);
  await external.patchMetadata((await external.get(ref))!, { labels: { phase: "changed" } });
  await waitFor(() => seen.includes("changed"));
  await runtime.close();
  runtime = new ApplicationRuntime(root, options);
  await runtime.start();
  const restored = await runtime.plugins.resourceClient("example").get(ref);
  assert.equal(restored?.metadata.uid, created.metadata.uid);
  assert.equal(restored?.metadata.labels?.phase, "changed");
  assert.equal(existsSync(join(root, "sessions")), false);
});

test("Resource commits publish no writes on rollback and isolate observer failures", async (t) => {
  const store = new PluginResourceStore({ home: home(t), pluginInstanceId: "example" });
  store.storage.register("example", [definition]);
  let observed = 0;
  store.storage.subscribeWrites(() => { throw new Error("observer failure"); });
  store.storage.subscribeWrites(() => { observed++; });
  const client = createResourceClient(store);
  await assert.rejects(client.commit([
    { operation: "create", type: TYPE, name: "one", spec: { text: "valid" } },
    { operation: "create", type: TYPE, name: "two", spec: { text: 42 } },
  ]));
  assert.equal(observed, 0);
  assert.equal((await client.list(TYPE)).length, 0);
  await client.create(TYPE, { name: "one", spec: { text: "valid" } });
  assert.equal(observed, 1);
});

test("Execution context follows resource incarnation and controller, independent of the journal", () => {
  const scope = { namespace: "v1" as const, executionId: "run-one", pluginInstanceId: "example",
    resourceRef: { ...TYPE, namespace: "v1" as const, name: "one", uid: "uid-one" } };
  const key = resourceExecutionKey(scope);
  assert.equal(resourceExecutionKey({ ...scope, executionId: "run-two" }), key);
  assert.notEqual(resourceExecutionKey({ ...scope, resourceRef: { ...scope.resourceRef, uid: "uid-two" } }), key);
  assert.notEqual(resourceExecutionKey({ ...scope, controllerName: "batch" }), key);
  assert.throws(() => resourceExecutionKey({ ...scope, resourceRef: { ...scope.resourceRef, uid: undefined } }), /UID-pinned/);
  assert.doesNotThrow(() => assertResourceUid("input:stable-id"));
  for (const uid of ["../other", "a/b", "a\\b", "", ".", ".."]) assert.throws(() => assertResourceUid(uid));
});

/** @case Journal growth cannot enlarge a reconciliation snapshot or expose unrelated executions. */
test("Reconcile snapshots contain configuration only and execution views require explicit IDs", async (t) => {
  const { createReconcileSnapshot } = await import("../src/host/plugin/reconcile-snapshot.ts");
  const { ExecutionService } = await import("../src/host/runtime/execution.ts");
  const { HarnessFixtures } = await import("./harness-fixture.ts");
  const root = home(t);
  const journal = new HarnessFixtures(root).create({ id: "aide:execution", cwd: root });
  for (const turnId of ["mine", "unrelated"]) journal.appendEvent({ kind: "_aide_invocation_summary", source: { type: "aide" },
    payload: { invocationId: turnId, finalText: turnId, toolCalls: [] } });
  const executions = new ExecutionService(root, { cwd: root, resolveTarget: () => undefined, mentionBudgetChars: 0, createAdapter: () => { throw new Error("No execution requested"); } });
  t.after(() => executions.close());
  const snapshot = createReconcileSnapshot({ cwd: root, harnessTargets: [{ id: "configured", harness: "test" }] });
  assert.deepEqual(Object.keys(snapshot).sort(), ["cwd", "harnessTargets"]);
  assert.ok(Object.isFrozen(snapshot.harnessTargets[0]));
  assert.deepEqual(executions.view([]).invocationSummaries, []);
  const selected = executions.view(["mine"]);
  assert.deepEqual(selected.invocationSummaries.map(turn => turn.invocationId), ["mine"]);
  selected.invocationSummaries[0]!.finalText = "caller mutation";
  assert.equal(executions.view(["mine"]).invocationSummaries[0]!.finalText, "mine");
  await executions.close();
  const reopened = new ExecutionService(root, { cwd: root, resolveTarget: () => undefined, mentionBudgetChars: 0, createAdapter: () => { throw new Error("No replay expected"); } });
  assert.equal(reopened.view(["mine"]).invocationSummaries[0]!.finalText, "mine");
  await reopened.close();
});

test("Failed application initialization releases its execution lease", async (t) => {
  const root = home(t);
  const { openHarnessStore } = await import("../src/host/harness/store.ts");
  await openHarnessStore(root, root).closeLogs();
  const options = {
    cwd: root, targets: [], instances: [],
    controller: { mentionBudgetChars: 0, createAdapter: () => { throw new Error("No Harness expected"); } },
    plugins: { maxTotalConcurrency: 0 },
  };
  assert.throws(() => new ApplicationRuntime(root, options), /maxTotalConcurrency/);
  let runtime: ApplicationRuntime | undefined;
  await waitFor(() => {
    try { runtime = new ApplicationRuntime(root, { ...options, plugins: {} }); return true; }
    catch (error) {
      if (error instanceof Error && error.message.includes("already active")) return false;
      throw error;
    }
  });
  await runtime!.close();
});

/** @case Read-only inspection and configured targets cannot force an unused Harness backend into existence. */
test("Unused Harness capabilities have no storage lifecycle", async (t) => {
  const { ExecutionService } = await import("../src/host/runtime/execution.ts");
  const root = home(t);
  const target = { id: "available", harness: "test" };
  const executions = new ExecutionService(root, { cwd: root, targets: [target], resolveTarget: () => target,
    mentionBudgetChars: 0, createAdapter: () => { throw new Error("Unused Harness must not start"); } });
  executions.registerTarget({ ...target, model: "configured" });
  const unsubscribe = executions.subscribe(() => {});
  assert.deepEqual(executions.listHarnessInvocations(), []);
  assert.deepEqual(executions.approvals(), []);
  assert.equal(executions.view([]).messages.size, 0);
  executions.failOrphans(); unsubscribe(); await executions.close();
  assert.equal(existsSync(join(root, "sessions")), false);
});

test("Harness acquires its lease before reading or changing existing metadata and releases it after failed recovery", async (t) => {
  const { ExecutionService } = await import("../src/host/runtime/execution.ts");
  const { openHarnessStore } = await import("../src/host/harness/store.ts");
  const { readFileSync, writeFileSync } = await import("node:fs");
  const root = home(t);
  const records = openHarnessStore(root, root);
  await records.closeLogs();
  const options = { cwd: root, mentionBudgetChars: 0, resolveTarget: () => undefined,
    createAdapter: () => { throw new Error("No dispatch expected"); } };
  const active = new ExecutionService(root, options);
  const before = readFileSync(join(records.dir, "meta.json"), "utf8");
  assert.throws(() => new ExecutionService(root, { ...options, cwd: "/changed" }), /already active/);
  assert.equal(readFileSync(join(records.dir, "meta.json"), "utf8"), before);
  await active.close();
  writeFileSync(join(records.dir, "session.jsonl"), "not-json\n{}\n");
  assert.throws(() => new ExecutionService(root, options), /corrupt Event Ledger/);
  assert.equal(existsSync(join(records.dir, "lock")), false);
  writeFileSync(join(records.dir, "session.jsonl"), "");
  await new ExecutionService(root, options).close();
});
