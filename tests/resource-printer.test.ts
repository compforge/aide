import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { cpSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { INPUT_TYPE, type InputSpec, type PluginPackage, type Resource, type ResourcePrinter } from "@compforge/aide-plugin";
import { Manager, type ManagerOptions } from "../src/host/plugin/manager.ts";
import { PluginInstanceStore } from "../src/host/plugin/instance.ts";
import { PluginSupervisor } from "../src/host/plugin/runner/index.ts";
import { SessionStore } from "../src/host/store/store.ts";

import { inputPrinter } from "../src/host/input/printer.ts";
import { executeCommand } from "./fixtures/command-context.ts";

const TYPE = { apiVersion: "tests.aide.dev/v1alpha1", kind: "Printable" };
const snapshot = (value = "hello"): Resource<{ value: string }, { phase: string }> => ({
  ...TYPE, metadata: { name: "sample", namespace: "v1", uid: "snapshot", resourceVersion: "2", generation: 1,
    creationTimestamp: "2026-10-21T00:00:00Z" }, spec: { value }, status: { phase: "ready" },
});
function fixture(t: TestContext, options: Partial<ManagerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "aide-printer-"));
  const session = new SessionStore(root).createSession({ id: "printer-session", cwd: root });
  const instances = new PluginInstanceStore({ session });
  const errors: unknown[] = [];
  const manager = new Manager({ session, instances,
    onActivationError: ({ error }) => { errors.push(error); }, ...options });
  t.after(async () => { await manager.close(); await session.closeLogs(); rmSync(root, { force: true, recursive: true }); });
  return { root, session, instances, manager, errors,
    add(id = "first", pluginId = "tests/printer", config = {}) {
      instances.create({ pluginInstanceId: id, pluginId, packageVersion: "1.0.0", ...(options.loadPackageEntry ? { marketplace: "fixture" } : {}), config });
    },
  };
}
function runnerFixture(t: TestContext, timeoutMs = 3000) {
  let entry = "";
  const f = fixture(t, { pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: timeoutMs }),
    async loadPackageEntry(pluginId, version) { return { pluginId, version, entryUrl: pathToFileURL(entry).href }; } });
  entry = join(f.root, "printer-plugin.ts");
  cpSync(join(import.meta.dir, "fixtures/printer-plugin.ts"), entry);
  return f;
}

/** @case Generic output needs neither a Controller nor a running Plugin. */
test("Resources without a Printer use JSON details and kind/name summaries", async (t) => {
  const { manager } = fixture(t);
  const resource = snapshot();
  assert.deepEqual(JSON.parse(await manager.describeResource("absent", resource)), resource);
  assert.equal(await manager.summarizeResource("absent", resource), "Printable/sample");
});

test("In-process Printers isolate snapshots, match exact GVK and withdraw when their Binding closes", async (t) => {
  const printer: ResourcePrinter<{ value: string }, { phase: string }> = {
    resourceType: TYPE,
    describe(resource) { resource.spec.value = "private copy"; return `${resource.metadata.name}: ${resource.spec.value}`; },
    summarize(resource) { return resource.spec.value; },
  };
  const plugin: PluginPackage = { pluginId: "tests/printer", version: "1.0.0",
    async activate(context) { context.printers.register(printer); } };
  const f = fixture(t, { packages: [plugin] }); f.add();
  await f.manager.start(); assert.deepEqual(f.errors, []);
  const resource = snapshot();
  assert.equal(await f.manager.describeResource("first", resource), "sample: private copy");
  assert.equal(resource.spec.value, "hello");
  assert.equal(await f.manager.summarizeResource("first", resource), "hello");
  const otherVersion = { ...resource, apiVersion: "tests.aide.dev/v2" };
  assert.deepEqual(JSON.parse(await f.manager.describeResource("first", otherVersion)), otherVersion);
  await f.manager.deactivateInstance("first");
  assert.equal(await f.manager.summarizeResource("first", resource), "Printable/sample");
  await f.manager.activateInstance("first");
  assert.equal(await f.manager.summarizeResource("first", resource), "hello");
});

test("Runner Printers receive the supplied snapshot, isolate Instances, and propagate logged errors", async (t) => {
  const f = runnerFixture(t); f.add("first"); f.add("second");
  await f.manager.start(); assert.deepEqual(f.errors, []);
  const resource = await f.manager.resourceClient("first").create<{ value: string }, { phase: string }>(TYPE, {
    name: "sample", spec: { value: "stored" }, status: { phase: "stored" },
  });
  const supplied = { ...resource, spec: { value: "snapshot" }, status: { phase: "supplied" } };
  const first = JSON.parse(await f.manager.describeResource("first", supplied));
  assert.notEqual(first.pid, process.pid);
  assert.deepEqual({ ...first, pid: 0 }, { pid: 0, instance: "first", name: "sample", value: "snapshot", phase: "supplied" });
  assert.equal(await f.manager.summarizeResource("second", supplied), "second: snapshot");
  for (const value of ["throw", "invalid", "async"]) {
    await assert.rejects(f.manager.describeResource("first", snapshot(value)), /Resource Printer describe failed/);
  }
  await f.session.flushLogs();
  const logs = readFileSync(join(f.session.dir, "session.log"), "utf8");
  assert.match(logs, /plugin.printer/);
  assert.match(logs, /Printer could not describe this value/);
  assert.equal(await f.manager.summarizeResource("first", supplied), "first: snapshot", "A callback error does not stop the Runner");
  await f.manager.deactivateInstance("first");
  assert.equal(await f.manager.summarizeResource("first", supplied), "Printable/sample");
  assert.equal(await f.manager.summarizeResource("second", supplied), "second: snapshot");
});

test("Duplicate Printer registration fails activation and rolls back host registrations", async (t) => {
  const f = runnerFixture(t); f.add("broken", "tests/printer", { duplicate: true }); f.add("healthy");
  await f.manager.start();
  assert.equal(f.errors.length, 1); assert.match(String(f.errors[0]), /already registered/);
  assert.equal(f.manager.isInstanceActive("broken"), false);
  assert.equal(await f.manager.summarizeResource("broken", snapshot()), "Printable/sample");
  assert.equal(await f.manager.summarizeResource("healthy", snapshot()), "healthy: hello");
});

test("Printer GVK ownership rejects Core and other plugins; failed activation releases its claim", async (t) => {
  const plugin = (id: string, fail = false, resourceType = TYPE): PluginPackage => ({
    pluginId: id, version: "1.0.0", async activate(context) {
      context.printers.register({ resourceType, describe: () => id, summarize: () => id });
      if (fail) throw new Error("activation stopped");
    },
  });
  const f = fixture(t, { packages: [plugin("broken", true), plugin("owner"), plugin("intruder"),
    plugin("core", false, { apiVersion: "aide.dev/v1alpha1", kind: "Input" })] });
  f.add("broken", "broken"); f.add("owner", "owner"); f.add("intruder", "intruder"); f.add("core", "core");
  // Explicit ordering makes ownership assertions independent of activation scheduling.
  await assert.rejects(f.manager.activateInstance("broken"), /activation stopped/);
  await f.manager.activateInstance("owner");
  await assert.rejects(f.manager.activateInstance("intruder"), /already registered by owner/);
  await assert.rejects(f.manager.activateInstance("core"), /already registered by Aide/);
  assert.equal(await f.manager.summarizeResource("owner", snapshot()), "owner");
  assert.equal(await f.manager.summarizeResource("broken", snapshot()), "Printable/sample");
});

test("A blocked Printer is bounded by the Runner watchdog and its registrations are withdrawn", async (t) => {
  const f = runnerFixture(t, 800); f.add();
  await f.manager.start(); assert.deepEqual(f.errors, []);
  await assert.rejects(f.manager.describeResource("first", snapshot("block")), /Resource Printer describe failed/);
  await f.manager.deactivateInstance("first");
  assert.equal(await f.manager.summarizeResource("first", snapshot()), "Printable/sample");
});


test("Core Input Printer works without a plugin and through Runner snapshot calls, and survives deactivation", async (t) => {
  const f = runnerFixture(t);
  const resource: Resource<InputSpec, {}> = { ...snapshot(), ...INPUT_TYPE,
    spec: { origin: "source", originId: "personal.lark", text: "原始 @ 消息", observation: { context: { messages: ["附近消息"] } } }, status: {} };
  const expected = { description: inputPrinter.describe(resource), summary: "原始 @ 消息" };
  assert.equal(await f.manager.describeResource("absent", resource), expected.description);
  f.add(); await f.manager.start(); assert.deepEqual(f.errors, []);
  const result = await executeCommand(f.manager, "print-resource", { argument: JSON.stringify(resource) });
  assert.equal(result?.kind, "message");
  if (result?.kind !== "message") throw new Error("Expected printed text");
  assert.deepEqual(JSON.parse(result.text), expected);
  const custom = await executeCommand(f.manager, "print-resource", { argument: JSON.stringify(snapshot()) });
  assert.equal(custom?.kind, "message");
  if (custom?.kind !== "message") throw new Error("Expected printed text");
  assert.equal(JSON.parse(custom.text).summary, "first: hello");
  await f.manager.deactivateInstance("first");
  assert.equal(await f.manager.describeResource("first", resource), expected.description);
  assert.equal(await f.manager.summarizeResource("first", resource), expected.summary);
});
