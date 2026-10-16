import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { Manager } from "../src/plugin/manager.ts";
import { PluginInstanceStore } from "../src/plugin/instance.ts";
import type { PluginPackage } from "../src/plugin/package.ts";
import type { SourceContext } from "../src/plugin/api/index.ts";

const type = { apiVersion: "test.dev/v1", kind: "Job" };
const secondary = { apiVersion: "test.dev/v1", kind: "Signal" };
const log = pino({ level: "silent" });

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "aide-manager-"));
  const instances = new PluginInstanceStore({ session: { id: "test", dir } });
  instances.create({ pluginInstanceId: "one", pluginId: "test", packageVersion: "1" });
  const manager = new Manager(instances, log);
  t.after(async () => { await manager.close(); rmSync(dir, { recursive: true, force: true }); });
  return { manager, instances };
}

async function until(condition: () => boolean, ms = 2000) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    assert.ok(Date.now() < deadline, "condition did not become true");
    await sleep(5);
  }
}

test("activation rolls back all registrations and permits a corrected activation", async (t) => {
  const { manager } = setup(t);
  const cleanup: number[] = [];
  await assert.rejects(manager.activate("one", { pluginId: "test", version: "1", activate(context) {
    context.registerController({ resourceType: type, reconcile: async () => {} });
    context.onClose(() => { cleanup.push(1); }); context.onClose(() => { cleanup.push(2); });
    throw new Error("bad config");
  } }), /bad config/);
  assert.deepEqual(cleanup, [2, 1]);
  let runs = 0;
  await manager.activate("one", { pluginId: "test", version: "1", activate(context) {
    context.registerController({ resourceType: type, reconcile: async () => { runs++; } });
  } });
  await manager.resources("one").create(type, { name: "job", spec: {} });
  await manager.start(); await manager.settled();
  assert.equal(runs, 1);
});

test("Source discovers existing work, emits live wakeups, and aborts on deactivation", async (t) => {
  const { manager } = setup(t);
  let source!: SourceContext<Record<string, unknown>>;
  let runs = 0;
  await manager.activate("one", { pluginId: "test", version: "1", activate(context) {
    context.registerController({ resourceType: type,
      sources: [{ type: "resource", sourceId: "feed", async start(ctx) {
        source = ctx; await ctx.emit({ name: "job", spec: {} });
      } }],
      async reconcile() { runs++; },
    });
  } });
  await manager.start(); await manager.settled(); assert.equal(runs, 1);
  await source.emit({ name: "job", spec: {} }); await manager.settled(); assert.equal(runs, 2);
  await source.emit({ name: "new", spec: {} }); await manager.settled(); assert.equal(runs, 3);
  await manager.deactivate("one"); assert.equal(source.signal.aborted, true);
  await source.emit({ name: "ignored", spec: {} });
  assert.equal(manager.resourceStore("one").list(type).length, 2);
});

test("Watch maps secondary changes and deletion finalizes owned resources", async (t) => {
  const { manager } = setup(t);
  let runs = 0;
  const clients = manager.resources("one");
  const owner = await clients.create(type, { name: "owner", spec: {} });
  await clients.create(type, { name: "child", spec: {}, owner: {
    ...type, namespace: "v1", name: "owner", uid: owner.metadata.uid,
  } });
  await manager.activate("one", { pluginId: "test", version: "1", activate(context) {
    context.registerController({ resourceType: type,
      watches: [{ resourceType: secondary, handler: {
        create: async () => [{ name: "owner" }], update: async () => [], delete: async () => [],
      } }],
      async reconcile() { runs++; },
    });
  } });
  await manager.start(); await manager.settled(); assert.equal(runs, 2);
  await clients.create(secondary, { name: "changed", spec: {} });
  await manager.settled(); assert.equal(runs, 3);
  await clients.delete(type, "owner"); await manager.settled();
  assert.equal((await clients.list(type)).length, 0);
});

test("requeue persists across restart and failed reconciliation retries through the same queue", async (t) => {
  const { manager, instances } = setup(t);
  let runs = 0;
  const plugin: PluginPackage = { pluginId: "test", version: "1", activate(context) {
    context.registerController({ resourceType: type, async reconcile() {
      runs++;
      if (runs === 1) return { requeueAfterMs: 50 };
      if (runs === 2) throw new Error("temporary observation failure");
    } });
  } };
  await manager.activate("one", plugin);
  await manager.resources("one").create(type, { name: "job", spec: {} });
  await manager.start(); await manager.settled();
  assert.equal(manager.resourceStore("one").scheduledReconciles(type).length, 1);
  await manager.close();
  const restarted = new Manager(instances, log);
  t.after(() => restarted.close());
  await restarted.activate("one", plugin); await restarted.start(); await restarted.settled();
  assert.equal(runs, 2);
  await until(() => runs === 3); await restarted.settled();
  assert.equal(restarted.resourceStore("one").scheduledReconciles(type).length, 0);
});

test("suspend releases local and global capacity while keeping same-resource exclusion", async (t) => {
  const { manager } = setup(t);
  let release!: () => void;
  const answer = new Promise<void>((resolve) => { release = resolve; });
  const seen: string[] = [];
  await manager.activate("one", { pluginId: "test", version: "1", activate(context) {
    context.registerController({ resourceType: type, maxConcurrency: 1, async reconcile(ctx, resource) {
      seen.push(resource.metadata.name);
      if (resource.metadata.name === "a") { await ctx.suspend(answer); seen.push("resumed"); }
    } });
  } });
  await manager.resources("one").create(type, { name: "a", spec: {} });
  await manager.resources("one").create(type, { name: "b", spec: {} });
  await manager.start();
  await until(() => seen.includes("b")); assert.deepEqual(seen, ["a", "b"]);
  release(); await manager.settled(); assert.deepEqual(seen, ["a", "b", "resumed"]);
});

test("a failed or duplicate registration never steals another Plugin's resource type", async (t) => {
  const { manager, instances } = setup(t);
  instances.create({ pluginInstanceId: "two", pluginId: "other", packageVersion: "1" });
  await manager.activate("one", { pluginId: "test", version: "1", activate(context) {
    context.registerController({ resourceType: type, async reconcile() {} });
  } });
  await assert.rejects(manager.activate("two", { pluginId: "other", version: "1", activate(context) {
    context.registerController({ resourceType: type, async reconcile() {} });
  } }), /already registered/);
});
