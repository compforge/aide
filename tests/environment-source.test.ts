import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { EnvironmentSnapshot, WorkloadSnapshot } from "@compforge/aide-plugin";
import { SessionStore } from "../src/host/store/store.ts";
import { ConversationStore } from "../src/host/conversation/store.ts";
import { AideResourceProvider } from "../src/host/plugin/aide-resource.ts";
import { PluginResourceStore } from "../src/host/plugin/resource.ts";
import { createResourceClient } from "../src/host/plugin/resource-client.ts";
import { emptyConnectors } from "../src/connector-client.ts";
import { ENVIRONMENT_SOURCE_TYPE, observeEnvironment, type EnvironmentSourceStatus } from "../plugins/personal/environment-source.ts";
import { parseEnvironmentWatches, type EnvironmentWatch } from "../plugins/personal/environment-config.ts";
import { Aide } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { fakeOptions } from "./fake-harness.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const workload = (version: string): WorkloadSnapshot => ({ kind: "Deployment", name: "api", uid: "deploy", generation: 1,
  desired: 1, ready: 1, images: [{ name: "api", image: version }], pods: [] });
const snapshot = (version: string): EnvironmentSnapshot => ({ environment: "dev", namespace: "app", observedAt: new Date().toISOString(), workloads: [workload(version)] });

test("Environment baseline, interrupted input commit, restart, and repeated A-B transitions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-env-source-"));
  const sessions = new SessionStore(root); const session = sessions.createSession({ id: "owner", cwd: root });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  const conversations = new ConversationStore(session);
  let store = new PluginResourceStore({ session, pluginInstanceId: "personal" });
  const resources = () => createResourceClient(store, undefined, undefined, new AideResourceProvider({ session, conversations }));
  const watch = parseEnvironmentWatches({ environmentWatches: [{ id: "changes", environment: "dev", conversationId: "chat" }] })[0]!;
  store.create({ type: ENVIRONMENT_SOURCE_TYPE, name: "changes", spec: watch, status: {} });
  let current = snapshot("A"); let failure = false; let reads = 0;
  const connectors = { ...emptyConnectors, environments: { ...emptyConnectors.environments, async workloads() {
    reads++; if (failure) throw new Error("Forbidden"); return current;
  } } };
  const resource = () => store.get<EnvironmentWatch, EnvironmentSourceStatus>(ENVIRONMENT_SOURCE_TYPE, "changes");
  const observe = () => observeEnvironment({ logger, resources: resources() }, resource(), connectors);
  await observe(); assert.equal(conversations.inputs().length, 0);
  current = { ...current, observedAt: "later" }; await observe(); assert.equal(conversations.inputs().length, 0);
  current = snapshot("B");
  await assert.rejects(observeEnvironment({ logger, resources: { ...resources(), async patchStatus() { throw new Error("Crash"); } } }, resource(), connectors), /Crash/);
  assert.equal(conversations.inputs().length, 1);
  assert.equal(resource().status.baseline!.workloads[0]!.images[0]!.image, "A");
  const reopened = sessions.openSession(session.id);
  t.after(() => reopened.closeLogs());
  store = new PluginResourceStore({ session: reopened, pluginInstanceId: "personal" });
  current = snapshot("C"); const previousReads = reads;
  await observe(); assert.equal(reads, previousReads, "Recover the committed input before reading the new live value");
  assert.equal(resource().status.baseline!.workloads[0]!.images[0]!.image, "B");
  assert.equal(conversations.inputs().length, 1);
  await observe(); assert.equal(conversations.inputs().length, 2);
  current = snapshot("A"); await observe();
  current = snapshot("B"); await observe();
  assert.equal(conversations.inputs().length, 4, "A-B occurs twice and needs two independent input identities");
  failure = true; const baseline = resource().status.baseline;
  await assert.rejects(observe(), /Forbidden/); assert.deepEqual(resource().status.baseline, baseline);
  failure = false; current = { ...snapshot("B"), workloads: [] }; await observe();
  const event = conversations.inputs().at(-1)!.spec.observation!;
  assert.deepEqual((event.changes as { after?: unknown }[]).map((c) => c.after), [undefined]);
  assert.ok(conversations.inputs().every((input) => input.spec.conversationId === "chat"));
  assert.equal(store.list({ apiVersion: "aide.dev/v1alpha1", kind: "Task" }).length, 0);
});

test("Environment watches require explicit supported access and preserve Session/Conversation routing", () => {
  const watches = parseEnvironmentWatches({ environmentWatches: [{ id: "default", environment: "dev" },
    { id: "shared", environment: "dev", conversationId: "feishu:chat" },
    { id: "separate", environment: "dev", sessionId: "owner", conversationId: "conv" }] });
  assert.deepEqual(watches.map((watch) => [watch.sessionId, watch.conversationId]),
    [["environment:default", "environment:default"], ["feishu:chat", "feishu:chat"], ["owner", "conv"]]);
  assert.throws(() => parseEnvironmentWatches({ environmentWatches: [watches[0], watches[0]] }), /Duplicate/);
  assert.throws(() => parseEnvironmentWatches({ environmentWatches: [{ id: "x", environment: "dev", intervalMs: 1 }] }));
});

test("Real Runner observes through Connector Verb, routes to Chief once, and restores its baseline", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-env-runner-"));
  const configFile = join(root, "config.yaml");
  writeFileSync(configFile, JSON.stringify({ connectors: { environments: {
    dev: { kind: "kubernetes", kubeconfig: "unused", namespace: "app", aliases: ["开发"] },
  } }, plugins: { personal: { environmentWatches: [{ id: "changes", environment: "开发", sessionId: "owner", conversationId: "target" }] } } }));
  let current = snapshot("A"); let reads = 0;
  const prompts: string[] = [];
  const config = loadConfig(configFile);
  const options = { ...fakeOptions({ chief: async () => "关注的服务有变化", async execute() { throw new Error("Unexpected work"); } }, root, prompts), config,
    connectors: { ...emptyConnectors, environments: { ...emptyConnectors.environments, async workloads(name: string, namespace?: string) {
      assert.equal(name, "dev"); assert.equal(namespace, "app"); reads++; return current;
    } } } };
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.start(); await aide.settled();
  assert.ok(reads >= 1); assert.equal(prompts.length, 0);
  const initialReads = reads;
  await aide.receive({ sessionId: "unrelated", conversationId: "other", id: "hello", text: "hello" }); await aide.settled();
  assert.equal(reads, initialReads, "Opening another Session must not duplicate the observer");
  current = snapshot("B");
  const poll = async () => {
    const scope = aide.session("owner");
    const resources = await scope.plugins.resourceClient("personal").list(ENVIRONMENT_SOURCE_TYPE);
    await scope.plugins.enqueue({ aideSessionId: scope.id, pluginInstanceId: "personal", namespace: "v1",
      resourceApiVersion: ENVIRONMENT_SOURCE_TYPE.apiVersion, resourceKind: ENVIRONMENT_SOURCE_TYPE.kind, resourceId: resources[0]!.metadata.name });
    for (let attempt = 0; attempt < 500; attempt++) {
      if (scope.conversations.inputs().some((input) => input.status.phase === "done")) break;
      await Bun.sleep(10);
    }
    await aide.settled();
    assert.ok(scope.conversations.inputs().some((input) => input.status.phase === "done"));
  };
  await poll();
  assert.equal(aide.session("owner").conversations.inputs().length, 1);
  assert.match(prompts.at(-1)!, /workload.changed/);
  assert.ok(aide.messages().filter((message) => message.conversationId === "target").some((message) => message.text === "关注的服务有变化"));
  assert.equal(aide.works().length, 0);
  const sessions = new SessionStore(root); const persisted = sessions.openSession("owner");
  const events = persisted.ledger.read().filter((event) => event.kind === "connector.started");
  assert.ok(events.some((event) => JSON.stringify(event.payload).includes("environments.workloads")));
  await persisted.closeLogs();
  await aide.close(); aide = new Aide(root, options, pino({ level: "silent" }));
  await aide.start(); await aide.settled();
  assert.equal(aide.session("owner").conversations.inputs().length, 1);
  assert.equal(prompts.length, 2);
});
