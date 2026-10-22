import { EventLedger } from "../src/host/event/ledger.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { resourceHome } from "../src/host/resource/storage.ts";
import personalDefinitions from "../plugins/personal/definitions.ts";
import { fixtureIncoming } from "./address-fixture.ts";
import { SOURCES } from "../plugins/personal/source/definition.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { EnvironmentSnapshot, WorkloadSnapshot } from "@compforge/aide-plugin";
import { HarnessFixtures } from "./harness-fixture.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { personalAdmission } from "../plugins/personal/admission.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { emptyConnectors } from "../src/connector-client.ts";
import { ENVIRONMENT_SOURCE_TYPE, observeEnvironment, type EnvironmentSourceStatus } from "../plugins/personal/source/environment/observe.ts";
import { environmentSources, EnvironmentWatchSchema, ENVIRONMENT_SESSION, type EnvironmentSourceSpec } from "../plugins/personal/source/environment/config.ts";
import { Aide } from "../src/app.ts";
import { loadConfig } from "../src/config.ts";
import { fakeOptions } from "./fake-harness.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const workload = (version: string): WorkloadSnapshot => ({ kind: "Deployment", name: "api", uid: "deploy", generation: 1,
  desired: 1, ready: 1, images: [{ name: "api", image: version }], pods: [] });
const snapshot = (version: string): EnvironmentSnapshot => ({ environment: "dev", namespace: "app", observedAt: new Date().toISOString(), workloads: [workload(version)] });

test("Environment baseline, interrupted input commit, restart, and repeated A-B transitions", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-env-source-"));
  const sessions = new HarnessFixtures(root); const session = sessions.create({ id: "owner", cwd: root });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  const conversations = new InputStore(session.dir);
  let store = new PluginResourceStore({ home: resourceHome(session.dir), pluginInstanceId: "personal" });
  store.storage.register("personal", personalDefinitions);
  const resources = () => createResourceClient(store, undefined, undefined, personalAdmission(conversations, new OutputStore(resourceHome(session.dir))));
  const watch: EnvironmentSourceSpec = { environment: "dev", namespace: "app", intervalMs: 300_000 };
  store.create({ type: ENVIRONMENT_SOURCE_TYPE, name: "changes", spec: watch, status: {} });
  let current = snapshot("A"); let failure = false; let reads = 0;
  const connectors = { ...emptyConnectors, environments: { ...emptyConnectors.environments, async workloads() {
    reads++; if (failure) throw new Error("Forbidden"); return current;
  } } };
  const resource = () => store.get<EnvironmentSourceSpec, EnvironmentSourceStatus>(ENVIRONMENT_SOURCE_TYPE, "changes");
  const observe = () => observeEnvironment({ logger, resources: resources() }, resource(), connectors);
  await observe(); assert.equal(conversations.list().length, 0);
  current = { ...current, observedAt: "later" }; await observe(); assert.equal(conversations.list().length, 0);
  current = snapshot("B");
  await assert.rejects(observeEnvironment({ logger, resources: { ...resources(), async patchStatus() { throw new Error("Crash"); } } }, resource(), connectors), /Crash/);
  assert.equal(conversations.list().length, 1);
  assert.match(conversations.list()[0]!.spec.text, /dev \/ app.*Workload/);
  assert.match(conversations.list()[0]!.spec.text, /Deployment api.*镜像 A → B/);
  assert.equal(conversations.list()[0]!.spec.originRef!.uid, resource().metadata.uid);
  assert.equal(resource().status.baseline!.workloads[0]!.images[0]!.image, "A");
  const reopened = sessions.open(session.id);
  t.after(() => reopened.closeLogs());
  store = new PluginResourceStore({ home: resourceHome(reopened.dir), pluginInstanceId: "personal" });
  current = snapshot("C"); const previousReads = reads;
  await observe(); assert.equal(reads, previousReads, "Recover the committed input before reading the new live value");
  assert.equal(resource().status.baseline!.workloads[0]!.images[0]!.image, "B");
  assert.equal(conversations.list().length, 1);
  await observe(); assert.equal(conversations.list().length, 2);
  current = snapshot("A"); await observe();
  current = snapshot("B"); await observe();
  assert.equal(conversations.list().length, 4, "A-B occurs twice and needs two independent input identities");
  failure = true; const baseline = resource().status.baseline;
  await assert.rejects(observe(), /Forbidden/); assert.deepEqual(resource().status.baseline, baseline);
  failure = false; current = { ...snapshot("B"), workloads: [] }; await observe();
  assert.ok(conversations.list().every((input) => input.spec.originId === SOURCES.environments.id));
  const event = conversations.list().at(-1)!.spec.observation!;
  assert.deepEqual((event.changes as { after?: unknown }[]).map((c) => c.after), [undefined]);
  assert.ok(conversations.list().every((input) => input.spec.sessionId === undefined));
  assert.equal(store.list({ apiVersion: "aide.dev/v1alpha1", kind: "Task" }).length, 0);
});

test("Environment policy selects namespaces independently of Connector defaults and resolves aliases", () => {
  const environments = [{ name: "dev", kind: "kubernetes" as const, kubeconfig: "test", namespace: "default", aliases: ["开发"] }];
  assert.deepEqual(environmentSources(undefined, environments), []);
  const policy = EnvironmentWatchSchema.parse({ targets: [{ environment: "开发", namespaces: ["app", "other"] }] });
  assert.deepEqual(environmentSources(policy, environments), [
    { environment: "dev", namespace: "app", intervalMs: 300_000 },
    { environment: "dev", namespace: "other", intervalMs: 300_000 },
  ]);
  assert.throws(() => environmentSources(policy, []), /unknown connector/);
  assert.throws(() => environmentSources(policy, [{ ...environments[0]!, kind: "host" }]), /local Kubernetes/);
  assert.throws(() => environmentSources(policy, [{ ...environments[0]!, host: { name: "box", transport: "ssh", address: "box" } }]), /local Kubernetes/);
  assert.throws(() => environmentSources({ ...policy, targets: [...policy.targets, { environment: "dev", namespaces: ["app"] }] }, environments), /Duplicate/);
});

test("Real Runner observes through Connector Verb, routes to Chief once, and restores its baseline", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-env-runner-"));
  const configFile = join(root, "config.yaml");
  writeFileSync(configFile, JSON.stringify({ connectors: { environments: {
    dev: { kind: "kubernetes", kubeconfig: "unused", namespace: "app", aliases: ["开发"] },
  } }, plugins: { personal: { route: { batchSize: 1 }, conversation: { batchSize: 1 }, sources: { environments: { targets: [{ environment: "dev", namespaces: ["app", "other"] }] } } } } }));
  let current = snapshot("A"); let reads = 0;
  const prompts: string[] = [];
  const config = loadConfig(configFile);
  const options = { ...fakeOptions({ chief: async () => "关注的服务有变化", async execute() { throw new Error("Unexpected work"); } }, root, prompts), config,
    connectors: { ...emptyConnectors, environments: { ...emptyConnectors.environments, async workloads(name: string, namespace?: string) {
      assert.equal(name, "dev"); assert.ok(["app", "other"].includes(namespace!)); reads++;
      return namespace === "app" ? current : { ...snapshot("unchanged"), namespace: "other" };
    } } } };
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.start(); await aide.settled();
  assert.ok(reads >= 2); assert.equal(prompts.length, 0);
  const initialReads = reads;
  await aide.receive(fixtureIncoming({ channelId: "web", sessionId: "other", conversationId: "other", id: "hello", text: "hello" })); await aide.settled();
  assert.equal(reads, initialReads, "Opening another Session must not duplicate the observer");
  await aide.setDefaultConversation("other", true);
  current = snapshot("B");
  const poll = async () => {
    const scope = aide.personal;
    const resources = await scope.plugins.resourceClient("personal").list(ENVIRONMENT_SOURCE_TYPE);
    assert.equal(resources.length, 2);
    for (const resource of resources) await scope.plugins.enqueue({ pluginInstanceId: "personal", namespace: "v1",
      resourceApiVersion: ENVIRONMENT_SOURCE_TYPE.apiVersion, resourceKind: ENVIRONMENT_SOURCE_TYPE.kind, resourceId: resource.metadata.name });
    for (let attempt = 0; attempt < 500; attempt++) {
      if (scope.conversations.inputStore.list().some((input) => input.status.routing?.phase === "done")) break;
      await Bun.sleep(10);
    }
    await aide.settled();
    assert.ok(scope.conversations.inputStore.list().some((input) => input.status.routing?.phase === "done"));
  };
  await poll();
  assert.equal(aide.personal.conversations.inputStore.list().filter((input) => input.spec.originId === "personal.environments").length, 1);
  assert.match(prompts.at(-1)!, /workload.changed/);
  assert.ok(aide.outputs().filter((message) => message.conversationId === "other").some((message) => message.text === "关注的服务有变化"));
  assert.equal(aide.works().length, 0);
  const sessions = new HarnessFixtures(root); const persisted = sessions.open("aide:execution");
  const events = new EventLedger({ path: join(root, "connectors", "calls.jsonl") }).read().filter((event) => event.kind === "connector.started");
  assert.ok(events.some((event) => JSON.stringify(event.payload).includes("environments.workloads")));
  await persisted.closeLogs();
  await aide.close(); aide = new Aide(root, options, pino({ level: "silent" }));
  await aide.start(); await aide.settled();
  assert.equal(aide.personal.conversations.inputStore.list().filter((input) => input.spec.originId === "personal.environments").length, 1);
  assert.equal(prompts.length, 3, "Channel, semantic routing and observation handling each call their Agent once");
});
