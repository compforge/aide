import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { cpSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type PluginPackage, type Resource } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec } from "../plugins/personal/input/model.ts";
import { Manager, type ManagerOptions } from "../src/host/plugin/manager.ts";
import { PluginInstanceStore } from "../src/host/plugin/instance.ts";
import { PluginSupervisor } from "../src/host/plugin/runner/index.ts";
import { SessionStore } from "../src/host/store/store.ts";
import { inputPrinter } from "../plugins/personal/input/printer.ts";
import { executeCommand } from "./fixtures/command-context.ts";
import { definition } from "./fixtures/resource-definition.ts";
import definitions, { TYPE } from "./fixtures/printer-definitions.ts";

const snapshot = (value = "hello"): Resource<{ value: string }, { phase: string }> => ({
  ...TYPE, metadata: { name: "sample", namespace: "v1", uid: "snapshot", resourceVersion: "2", generation: 1,
    creationTimestamp: "2026-10-21T00:00:00Z" }, spec: { value }, status: { phase: "ready" },
});
function fixture(t: TestContext, options: Partial<ManagerOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "aide-printer-"));
  const session = new SessionStore(root).createSession({ id: "printer-session", cwd: root });
  const instances = new PluginInstanceStore({ session });
  const errors: unknown[] = [];
  const manager = new Manager({ session, instances, onActivationError: ({ error }) => errors.push(error), ...options });
  t.after(async () => { await manager.close(); await session.closeLogs(); rmSync(root, { force: true, recursive: true }); });
  return { root, session, instances, manager, errors,
    add(id = "first", pluginId = "tests/printer", config = {}) {
      instances.create({ pluginInstanceId: id, pluginId, packageVersion: "1.0.0", ...(options.loadPackageEntry ? { marketplace: "fixture" } : {}), config });
    },
  };
}
function runnerFixture(t: TestContext) {
  let root = "";
  const f = fixture(t, { pluginSupervisor: new PluginSupervisor({ requestTimeoutMs: 3000 }),
    async loadPackageEntry(pluginId, version) { return { pluginId, version,
      entryUrl: pathToFileURL(join(root, "printer-plugin.ts")).href,
      resourcesUrl: pathToFileURL(join(root, "printer-definitions.ts")).href }; },
  });
  root = f.root;
  for (const file of ["printer-plugin.ts", "printer-definitions.ts"]) cpSync(join(import.meta.dir, "fixtures", file), join(root, file));
  return f;
}

test("Missing Printer uses generic text without a Controller or running Plugin", async (t) => {
  const { manager } = fixture(t);
  assert.deepEqual(JSON.parse(await manager.describeResource("absent", snapshot())), snapshot());
  assert.equal(await manager.summarizeResource("absent", snapshot()), "Printable/sample");
});

test("Definition Printers isolate snapshots, match exact GVK and survive activation failure and close", async (t) => {
  const declared = { ...definition(TYPE), printer: {
    describe(r: Resource) { r.spec.value = "private copy"; return String(r.spec.value); }, summarize(r: Resource) { return String(r.spec.value); },
  } };
  const plugin: PluginPackage = { pluginId: "tests/printer", version: "1.0.0", resources: [declared],
    async activate() { throw new Error("activation failed"); } };
  const f = fixture(t, { packages: [plugin] }); f.add();
  await assert.rejects(f.manager.activateInstance("first"), /activation failed/);
  const supplied = snapshot();
  assert.equal(await f.manager.describeResource("first", supplied), "private copy");
  assert.equal(supplied.spec.value, "hello");
  assert.equal(await f.manager.summarizeResource("first", supplied), "hello");
  const other = { ...supplied, apiVersion: "tests.aide.dev/v2" };
  assert.deepEqual(JSON.parse(await f.manager.describeResource("first", other)), other);
  await f.manager.close();
  assert.equal(await f.manager.summarizeResource("first", supplied), "hello");
});

test("Runner calls Host Definition Printer with supplied snapshots; errors are logged and never hidden", async (t) => {
  const f = runnerFixture(t); f.add(); await f.manager.start(); assert.deepEqual(f.errors, []);
  const persisted = await f.manager.resourceClient("first").create(TYPE, { name: "sample", spec: { value: "stored" }, status: { phase: "stored" } });
  const supplied = { ...persisted, spec: { value: "snapshot" } };
  const result = await executeCommand(f.manager, "print-resource", { argument: JSON.stringify(supplied) });
  assert.equal(result?.kind, "message");
  if (result?.kind !== "message") throw new Error("Expected printed text");
  assert.deepEqual(JSON.parse(JSON.parse(result.text).description), { pid: process.pid, name: "sample", value: "snapshot", phase: "stored" });
  for (const value of ["throw", "invalid", "async"]) await assert.rejects(f.manager.describeResource("first", snapshot(value)), /Resource Printer describe failed/);
  await f.session.flushLogs();
  assert.match(readFileSync(join(f.session.dir, "session.log"), "utf8"), /Printer could not describe this value/);
  await f.manager.deactivateInstance("first");
  assert.equal(await f.manager.summarizeResource("first", snapshot()), "summary: hello");
  assert.equal((await f.manager.resourceClient("first").get<{ value: string }, unknown>({ ...TYPE, namespace: "v1", name: "sample" }))?.spec.value, "stored");
});

test("Duplicate definitions fail before activation; only plugin ownership reserves a type", async (t) => {
  const printable = definitions[0]!;
  const plugin = (id: string, resources = [printable]): PluginPackage => ({ pluginId: id, version: "1.0.0", resources, async activate() {} });
  const f = fixture(t, { packages: [plugin("duplicate", [printable, printable]), plugin("owner"), plugin("intruder"), plugin("core", [definition(INPUT_TYPE)])] });
  for (const id of ["duplicate", "owner", "intruder", "core"]) f.add(id, id);
  await assert.rejects(f.manager.activateInstance("duplicate"), /already registered/);
  await f.manager.activateInstance("owner");
  await assert.rejects(f.manager.activateInstance("intruder"), /already registered by owner/);
  await f.manager.activateInstance("core");
  assert.equal(await f.manager.summarizeResource("duplicate", snapshot()), "Printable/sample");
});

test("Personal Input Printer requires its plugin definition", async (t) => {
  const f = fixture(t);
  const resource: Resource<InputSpec, {}> = { ...snapshot(), ...INPUT_TYPE,
    spec: { origin: "source", originId: "personal.lark", text: "原始消息" }, status: {} };
  assert.equal(await f.manager.describeResource("absent", resource), JSON.stringify(resource, null, 2));
  const { InputDefinition } = await import("../plugins/personal/input/definition.ts");
  const { ResourceStorage } = await import("../src/host/resource/storage.ts");
  ResourceStorage.open(f.root).register("personal", [InputDefinition]);
  assert.equal(await f.manager.describeResource("personal", resource), inputPrinter.describe(resource));
});
