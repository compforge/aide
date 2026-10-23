import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { PluginPackage, ResourceDefinition } from "@compforge/aide-plugin";
import { ApplicationRuntime } from "../src/host/runtime/index.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
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
      for (const retired of ["session", "commands", "mentions", "toast"]) assert.equal(retired in context, false);
      assert.equal("aideSessionId" in context.instance, false);
      assert.deepEqual(Object.keys(context.dataDirs).sort(), ["global", "instance"]);
      context.controllers.register({ resourceType: TYPE, async reconcile(_execution, resource) {
        seen.push(resource.metadata.labels?.phase);
        await context.resources.patchStatus(resource, { reconciled: true });
      } });
    },
  };
  const options = {
    cwd: root, instances: [{ pluginInstanceId: "example", pluginId: "example", packageVersion: "1.0.0", config: {} }],
    plugins: { packages: [plugin], onActivationError: ({ error }: { error: unknown }) => { failures.push(error); } },
  };
  let runtime = new ApplicationRuntime(root, options);
  t.after(async () => { await runtime.close(); });
  await runtime.start();
  assert.deepEqual(failures, []);
  assert.equal(existsSync(join(root, "harness")), false);
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
  assert.equal(existsSync(join(root, "harness")), false);
});

/** @case Resource-only startup ignores Harness storage and reports an unavailable verb without losing resource progress. */
test("Resource-only runtime does not load Harness history or require an execution backend", async (t) => {
  const root = home(t);
  const history = join(root, "harness");
  mkdirSync(history, { recursive: true });
  const metadata = join(history, "meta.json");
  writeFileSync(metadata, "invalid unused Harness metadata");
  const results: unknown[] = [];
  const plugin: PluginPackage = {
    pluginId: "example", version: "1.0.0", resources: [definition],
    async activate(context) {
      context.controllers.register({ resourceType: TYPE, async reconcile(execution, resource) {
        results.push(await execution.verbs.harness({ title: "Unavailable", prompt: "Hello", timeoutMs: 1000 }));
        await context.resources.patchStatus(resource, { reconciled: true });
      } });
    },
  };
  const runtime = new ApplicationRuntime(root, { cwd: root,
    instances: [{ pluginInstanceId: "example", pluginId: "example", packageVersion: "1.0.0", config: {} }],
    plugins: { packages: [plugin] },
  });
  t.after(() => runtime.close());
  await runtime.start();
  assert.throws(() => runtime.executions, /Harness execution is not configured/);
  assert.deepEqual(runtime.harnesses, []);
  const client = runtime.plugins.resourceClient("example");
  const resource = await client.create(TYPE, { name: "one", spec: { text: "hello" } });
  await runtime.plugins.settled();
  assert.deepEqual(results, [{ state: "failure", error: "harness() requires a configured Harness execution capability" }]);
  assert.equal((await client.get<{ text: string }, { reconciled: boolean }>({ ...TYPE, namespace: "v1", name: "one", uid: resource.metadata.uid }))?.status.reconciled, true);
  await runtime.close();
  assert.equal(readFileSync(metadata, "utf8"), "invalid unused Harness metadata");
  assert.equal(existsSync(join(history, "lock")), false);
  assert.equal(existsSync(join(history, "events.jsonl")), false);
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

test("Resource UIDs remain safe storage identities", () => {
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
  const executions = new ExecutionService(root, { cwd: root, resolveHarness: () => undefined, createAdapter: () => { throw new Error("No execution requested"); } });
  t.after(() => executions.close());
  const snapshot = createReconcileSnapshot({ cwd: root, harnesses: [{ id: "configured", harness: "test" }] });
  assert.deepEqual(Object.keys(snapshot).sort(), ["cwd", "harnesses"]);
  assert.ok(Object.isFrozen(snapshot.harnesses[0]));
  assert.deepEqual(executions.view([]).invocationSummaries, []);
  assert.deepEqual(executions.view(["mine"]).invocationSummaries, [], "Execution history is never imported from another runtime");
  await executions.close();
  assert.equal(existsSync(join(root, "events.jsonl")), false);

});

test("Failed application initialization releases its execution lease", async (t) => {
  const root = home(t);
  const options = {
    cwd: root, instances: [],
    harness: { harnesses: [], createAdapter: () => { throw new Error("No Harness expected"); } },
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

/** @case Read-only inspection and configured harnesses cannot force an unused Harness backend into existence. */
test("Unused Harness capabilities have no storage lifecycle", async (t) => {
  const { ExecutionService } = await import("../src/host/runtime/execution.ts");
  const root = home(t);
  const target = { id: "available", harness: "test" };
  const executions = new ExecutionService(root, { cwd: root, harnesses: [target], resolveHarness: () => target, createAdapter: () => { throw new Error("Unused Harness must not start"); } });
  const unsubscribe = executions.subscribe(() => {});
  assert.deepEqual(executions.listHarnessInvocations(), []);
  assert.deepEqual(executions.approvals(), []);
  assert.equal(executions.view([]).messages.size, 0);
  unsubscribe(); await executions.close();
  assert.equal(existsSync(join(root, "harness")), false);
});
