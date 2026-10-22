import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { CoreSession } from "../src/host/core/index.ts";
import { SessionStore } from "../src/host/store/store.ts";
import { PluginInstanceStore } from "../src/host/plugin/instance.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { PluginSupervisor } from "../src/host/plugin/runner/index.ts";
import { ConversationStore } from "./conversation-fixture.ts";
import { Store } from "../plugins/personal/store.ts";
import { WorkService } from "../plugins/personal/work.ts";
import { conversationView } from "../src/channel/view.ts";
import type { ChannelService } from "../src/channel/service.ts";
import { fakeOptions } from "./fake-harness.ts";

/** @case Work tools notify secondary Watches; a non-Chief controller streams in its own conversation. */
test("Work tool -> Runner Watch -> Connector verb -> Harness uses explicit conversation", async () => {
  const root = mkdtempSync(join(tmpdir(), "aide-core-coordination-"));
  const session = new SessionStore(root).createSession({ cwd: root });
  session.setHarnessTarget("default", { harnessTargetId: "default", harness: "codex" });
  const instances = new PluginInstanceStore({ session });
  instances.create({ pluginInstanceId: "fixture", pluginId: "tests/coordination", packageVersion: "1.0.0", marketplace: "builtin" });
  const options = fakeOptions({ execute: async () => ({ action: "done", summary: "checked", notification: "ok", question: null, nextAt: null }) }, root);
  const core = new CoreSession({ session, controller: { mentionBudgetChars: 0, createAdapter: options.createAdapter, resolveTarget: () => ({ id: "default", harness: "codex" }) },
    plugins: { instances, pluginSupervisor: new PluginSupervisor(), harnessTargets: [{ id: "default", harness: "codex" }], selectedHarnessTargetId: () => "default",
      loadPackageEntry: async (pluginId, version) => ({ pluginId, version, entryUrl: new URL("./fixtures/coordination-plugin.ts", import.meta.url).href,
        resourcesUrl: new URL("./fixtures/coordination-definitions.ts", import.meta.url).href }) },
  });
  const manager = core.pluginManager!;
  const resources = new PluginResourceStore({ session, pluginInstanceId: "fixture" });
  const conversations = new ConversationStore(session);
  const store = new Store(resources, manager.resourceClient("fixture"), conversations);
  const work = new WorkService(store, "group-a", pino({ level: "silent" }));
  try {
    await core.start();
    const task = await work.create({ kind: "task", title: "检查", instruction: "check", trigger: null });
    await manager.settled();
    const observer = { apiVersion: "tests.aide.dev/v1alpha1", kind: "WorkObserver" };
    expect(resources.get(observer, "observer", "v1/project/coordination").status).toMatchObject({ answer: "observed", count: 1 });
    const projection: ChannelService = { inputDefinition: () => { throw new Error("No Input expected"); }, sessions: () => [{ id: session.id, core, conversations: conversations }],
      findConversation: (id) => id === "group-a" ? { id: session.id, core, conversations: conversations } : undefined,
      subscribe: (listener) => core.subscribe(listener), outputs: () => [], invocations: () => manager.listHarnessInvocations(), conversationIds: () => ["group-a"], receive: async () => { throw new Error("Not used"); } };
    expect(conversationView(projection, "group-a").blocks.some((block) => block.type === "execution")).toBe(true);
    expect(conversationView(projection, "group-b").blocks).toHaveLength(0);
    await work.appendInput(task.id, { action: "pause", text: "暂停" });
    await manager.settled();
    expect(resources.get(observer, "observer", "v1/project/coordination").status).toMatchObject({ revision: 2 });
    await work.delete(task.id, 2);
    await manager.settled();
    expect(resources.get(observer, "observer", "v1/project/coordination").status).toMatchObject({ count: 0 });
  } finally { await core.close(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);
