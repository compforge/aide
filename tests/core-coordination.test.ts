import { personalExecution } from "../plugins/personal/execution-context.ts";
import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { ApplicationRuntime } from "../src/host/runtime/index.ts";
import { HarnessFixtures } from "./harness-fixture.ts";
import { PluginInstanceStore } from "../src/host/plugin/instance.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { PluginSupervisor } from "../src/host/plugin/runner/index.ts";
import { TopicStore } from "./topic-fixture.ts";
import { Store } from "../plugins/personal/store.ts";
import { WorkService } from "../plugins/personal/work.ts";
import { topicView } from "../src/channel/view.ts";
import type { ChannelService } from "../src/channel/service.ts";
import { fakeOptions } from "./fake-harness.ts";

/** @case Work tools notify secondary Watches; a non-Chief controller streams in its own topic. */
test("Work tool -> Runner Watch -> Connector verb -> Harness uses explicit topic", async () => {
  const root = mkdtempSync(join(tmpdir(), "aide-core-coordination-"));
  const session = new HarnessFixtures(root).create({ cwd: root });
  const options = fakeOptions({ execute: async () => ({ action: "done", report: "checked", notification: "ok", question: null, nextAt: null }) }, root);
  const core = new ApplicationRuntime(root, { cwd: root,
    instances: [{ pluginInstanceId: "fixture", pluginId: "tests/coordination", packageVersion: "1.0.0", marketplace: "builtin", config: {} }],
    harness: { harnesses: [{ id: "default", harness: "codex" }], defaultHarness: "default", createAdapter: options.createAdapter },
    plugins: { pluginSupervisor: new PluginSupervisor(),
      loadPackageEntry: async (pluginId, version) => ({ pluginId, version, entryUrl: new URL("./fixtures/coordination-plugin.ts", import.meta.url).href,
        resourcesUrl: new URL("./fixtures/coordination-definitions.ts", import.meta.url).href }) },
  });
  const manager = core.plugins;
  const resources = new PluginResourceStore({ home: root, pluginInstanceId: "fixture" });
  const topics = new TopicStore(session);
  const store = new Store(resources, manager.resourceClient("fixture"), topics);
  const work = new WorkService(store, "group-a", pino({ level: "silent" }));
  try {
    await core.start();
    const task = await work.create({ kind: "task", title: "检查", instruction: "check", trigger: null });
    await manager.settled();
    const observer = { apiVersion: "tests.aide.dev/v1alpha1", kind: "WorkObserver" };
    expect(resources.get(observer, "observer", "v1/project/coordination").status).toMatchObject({ answer: "observed", count: 1 });
    const projection: ChannelService = { inputDefinition: () => { throw new Error("No Input expected"); }, runtime: core, topics,
      subscribe: (listener) => core.subscribe(listener), outputs: () => [], invocations: () => manager.listHarnessInvocations().map(invocation => ({ ...invocation, ...personalExecution(invocation) })), topicIds: () => ["group-a"], receive: async () => { throw new Error("Not used"); } };
    expect(topicView(projection, "group-a").blocks.some((block) => block.type === "execution")).toBe(true);
    expect(topicView(projection, "group-b").blocks).toHaveLength(0);
    await work.requestInput(task.id, { action: "pause", text: "暂停" });
    await manager.settled();
    expect(resources.get(observer, "observer", "v1/project/coordination").status).toMatchObject({ revision: 2 });
    await work.delete(task.id, 2);
    await manager.settled();
    expect(resources.get(observer, "observer", "v1/project/coordination").status).toMatchObject({ count: 0 });
  } finally { await core.close(); await session.closeLogs(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);
