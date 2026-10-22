import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
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
  type: TYPE, scope: "shared", schema: {
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
  const scope = { namespace: "v1" as const, executionId: "run-one", aideSessionId: "private-one", pluginInstanceId: "example",
    resourceRef: { ...TYPE, namespace: "v1" as const, name: "one", uid: "uid-one" } };
  const key = resourceExecutionKey(scope);
  assert.equal(resourceExecutionKey({ ...scope, executionId: "run-two", aideSessionId: "private-two" }), key);
  assert.notEqual(resourceExecutionKey({ ...scope, resourceRef: { ...scope.resourceRef, uid: "uid-two" } }), key);
  assert.notEqual(resourceExecutionKey({ ...scope, controllerName: "batch" }), key);
  assert.throws(() => resourceExecutionKey({ ...scope, resourceRef: { ...scope.resourceRef, uid: undefined } }), /UID-pinned/);
  assert.doesNotThrow(() => assertResourceUid("input:stable-id"));
  for (const uid of ["../other", "a/b", "a\\b", "", ".", ".."]) assert.throws(() => assertResourceUid(uid));
});
