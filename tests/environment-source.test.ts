import { InputAttention } from "../plugins/personal/input/model.ts";
import { describeWorkloadChanges } from "../plugins/personal/source/environment/changes.ts";
import { EventLedger } from "../src/host/event/ledger.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
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
  const topics = new InputStore(session.home);
  let store = new PluginResourceStore({ home: session.home, pluginInstanceId: "personal" });
  store.storage.register("personal", personalDefinitions);
  const resources = () => createResourceClient(store, undefined, undefined, personalAdmission(topics, new OutputStore(session.home)));
  const watch: EnvironmentSourceSpec = { environment: "dev", namespace: "app", intervalMs: 300_000 };
  store.create({ type: ENVIRONMENT_SOURCE_TYPE, name: "changes", spec: watch, status: {} });
  let current = snapshot("A"); let failure = false; let reads = 0;
  const connectors = { ...emptyConnectors, environments: { ...emptyConnectors.environments, async workloads() {
    reads++; if (failure) throw new Error("Forbidden"); return current;
  } } };
  const resource = () => store.get<EnvironmentSourceSpec, EnvironmentSourceStatus>(ENVIRONMENT_SOURCE_TYPE, "changes");
  const observe = () => observeEnvironment({ logger, resources: resources() }, resource(), connectors);
  await observe(); assert.equal(topics.list().length, 0);
  current = { ...current, observedAt: "later" }; await observe(); assert.equal(topics.list().length, 0);
  current = snapshot("B");
  await assert.rejects(observeEnvironment({ logger, resources: { ...resources(), async patchStatus() { throw new Error("Crash"); } } }, resource(), connectors), /Crash/);
  assert.equal(topics.list().length, 1);
  assert.match(topics.list()[0]!.spec.text, /dev \/ app.*Workload/);
  assert.match(topics.list()[0]!.spec.text, /Deployment api.*镜像 api=A → api=B/);
  assert.equal(topics.list()[0]!.spec.originRef!.uid, resource().metadata.uid);
  assert.equal(resource().status.baseline!.workloads[0]!.images[0]!.image, "A");
  const reopened = sessions.open(session.id);
  t.after(() => reopened.closeLogs());
  store = new PluginResourceStore({ home: reopened.home, pluginInstanceId: "personal" });
  current = snapshot("C"); const previousReads = reads;
  await observe(); assert.equal(reads, previousReads, "Recover the committed input before reading the new live value");
  assert.equal(resource().status.baseline!.workloads[0]!.images[0]!.image, "B");
  assert.equal(topics.list().length, 1);
  await observe(); assert.equal(topics.list().length, 2);
  current = snapshot("A"); await observe();
  current = snapshot("B"); await observe();
  assert.equal(topics.list().length, 4, "A-B occurs twice and needs two independent input identities");
  failure = true; const baseline = resource().status.baseline;
  await assert.rejects(observe(), /Forbidden/); assert.deepEqual(resource().status.baseline, baseline);
  failure = false; current = { ...snapshot("B"), workloads: [] }; await observe();
  assert.ok(topics.list().every((input) => input.spec.originId === SOURCES.environments.id && input.spec.attention === InputAttention.Deferred));
  const event = topics.list().at(-1)!.spec.observation!;
  assert.deepEqual((event.changes as { after?: unknown }[]).map((c) => c.after), [undefined]);
  assert.ok(topics.list().every((input) => input.spec.topicKey === "environment:dev" && input.spec.topicName === "dev"));
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

/** @case Environment Topics span namespaces, isolate environments, and preserve observation baselines on restart. */
test("Real Runner groups deferred observations by canonical environment and restores namespace baselines", { timeout: 15_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-env-runner-"));
  const configFile = join(root, "config.yaml");
  writeFileSync(configFile, JSON.stringify({ connectors: {environments: {kind:"environment",version:"v1",config:{
    dev: { kind: "kubernetes", kubeconfig: "unused", namespace: "app", aliases: ["开发"] },
    prod: { kind: "kubernetes", kubeconfig: "unused", namespace: "app" },
  }}}, plugins: { personal: { sources: { environments: { targets: [
    { environment: "开发", namespaces: ["app", "other"] }, { environment: "prod", namespaces: ["app"] },
  ] } } } } }));
  let current = snapshot("A"); let reads = 0;
  const prompts: string[] = [];
  const config = loadConfig(configFile);
  const options = { ...fakeOptions({ chief: async () => "关注的服务有变化", async execute() { throw new Error("Unexpected work"); } }, root, prompts), config,
    connectors: { ...emptyConnectors, environments: { ...emptyConnectors.environments, async workloads(name: string, namespace?: string) {
      assert.ok(["dev", "prod"].includes(name)); assert.ok(["app", "other"].includes(namespace!)); reads++;
      return { ...current, environment: name, namespace: namespace! };
    } } } };
  let aide = new Aide(root, options, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  await aide.start(); await aide.settled();
  assert.ok(reads >= 3); assert.equal(prompts.length, 0);
  const initialReads = reads;
  await aide.receive(fixtureIncoming({ channelId: "web", topicId: "other", id: "hello", text: "hello" })); await aide.settled();
  assert.equal(reads, initialReads, "Opening another Session must not duplicate the observer");
  current = snapshot("B");
  const poll = async () => {
    const scope = aide.personal;
    const resources = await scope.plugins.resourceClient("personal").list(ENVIRONMENT_SOURCE_TYPE);
    assert.equal(resources.length, 3);
    for (const resource of resources) await scope.plugins.enqueue({ pluginInstanceId: "personal", namespace: "v1",
      resourceApiVersion: ENVIRONMENT_SOURCE_TYPE.apiVersion, resourceKind: ENVIRONMENT_SOURCE_TYPE.kind, resourceId: resource.metadata.name });
    for (let attempt = 0; attempt < 500; attempt++) {
      if (scope.topics.inputStore.list().filter(input => input.spec.originId === SOURCES.environments.id && input.status.route?.completedAt).length === 3) break;
      await Bun.sleep(10);
    }
    await aide.settled();
    assert.equal(scope.topics.inputStore.list().filter(input => input.spec.originId === SOURCES.environments.id && input.status.route?.completedAt).length, 3);
  };
  await poll();
  assert.equal(aide.personal.topics.inputStore.list().filter((input) => input.spec.originId === "personal.environments").length, 3);
  assert.equal(prompts.length, 1, "Environment arrival must not call Chief");
  const inputs = aide.personal.topics.inputStore.list().filter(input => input.spec.originId === SOURCES.environments.id);
  const dev = inputs.filter(input => input.spec.topicKey === "environment:dev");
  const prod = inputs.filter(input => input.spec.topicKey === "environment:prod");
  assert.equal(dev.length, 2); assert.equal(prod.length, 1);
  assert.deepEqual(dev.map(input => input.spec.observation!.namespace).sort(), ["app", "other"]);
  const assignedUid = (input: typeof inputs[number]) => Object.values(input.status.assess!)[0]!.resource.uid;
  assert.equal(assignedUid(dev[0]!), assignedUid(dev[1]!));
  assert.notEqual(assignedUid(dev[0]!), assignedUid(prod[0]!));
  assert.ok(inputs.every(input => input.spec.topicName === input.spec.observation!.environment && input.spec.attention === InputAttention.Deferred));
  const input = dev[0]!;
  const assignment = Object.values(input.status.assess!)[0]!;
  assert.equal(assignment.executionId, undefined);
  const scope = aide.personal, client = scope.plugins.resourceClient("personal");
  const topic = (await client.get<import("../plugins/personal/topic/model.ts").TopicSpec, import("../plugins/personal/topic/model.ts").TopicStatus>(assignment.resource))!;
  assert.equal(topic.spec.name, "dev");
  await client.replace(topic, { ...topic.spec, trigger: { enabled: true } },
    { ...topic.status, nextTriggerAt: new Date(Date.now() - 1000).toISOString(), idleSince: new Date(Date.now() - 901_000).toISOString() });
  await scope.plugins.enqueue({ pluginInstanceId: "personal", namespace: "v1", resourceApiVersion: topic.apiVersion,
    resourceKind: topic.kind, resourceId: topic.metadata.name, controllerName: "agent" });
  await aide.settled();
  assert.ok(aide.topics.inputStore.get(input.metadata.name)!.status.assess![assignment.resource.uid]!.completedAt);
  assert.match(prompts.at(-1)!, /镜像 api=A → api=B/);
  assert.doesNotMatch(prompts.at(-1)!, /"before"|"after"/);
  assert.equal(aide.outputs().filter((message) => message.topicId !== "other").length, 0, "Source Topics do not inherit a reply address");
  assert.equal(aide.works().length, 0);
  const sessions = new HarnessFixtures(root); const persisted = sessions.open("aide:execution");
  const events = new EventLedger({ path: join(root, "connectors", "calls.jsonl") }).read().filter((event) => event.kind === "connector.started");
  assert.ok(events.some((event) => JSON.stringify(event.payload).includes("environments.workloads")));
  await persisted.closeLogs();
  await aide.close(); aide = new Aide(root, options, pino({ level: "silent" }));
  await aide.start(); await aide.settled();
  assert.equal(aide.personal.topics.inputStore.list().filter((input) => input.spec.originId === "personal.environments").length, 3);
  assert.equal(prompts.length, 2, "Channel and observation each call Chief once");
});

const pod = (uid: string, restarts = 0, imageId = "sha256:a") => ({ name: `api-${uid}`, uid, phase: "Running", ready: true, terminating: false,
  containers: [{ name: "api", image: "tag", imageId, ready: true, restarts, state: "running", reason: "", lastExitReason: "" }] });
const deltaText = (before: WorkloadSnapshot, after: WorkloadSnapshot) => describeWorkloadChanges({ type: "workload.changed", environment: "dev", namespace: "app",
  previousObservedAt: "2026-10-24T00:00:00Z", observedAt: "2026-10-24T00:05:00Z", changes: [{ before, after }] });

/** @case Aggregate counters must not mistake replacement resets for recovery or hide simultaneous restarts. */
test("environment delta separates Pod turnover from same-container restart increments", () => {
  const before = { ...workload("tag"), desired: 2, ready: 2, pods: [pod("removed", 20), pod("stays")] };
  const after = { ...before, pods: [pod("stays", 1), pod("added")] };
  const text = deltaText(before, after);
  assert.match(text, /Pod 新增 1、移除 1/);
  assert.match(text, /同一 Pod\/容器重启 \+1/);
  assert.match(text, /就绪副本 2\/2（未变）/);
  assert.doesNotMatch(text, /api-removed|api-added|发布|重启 -19/);
  const unknown = { ...after, pods: [pod("stays", 1), pod("newer", 4)] };
  assert.match(deltaText(after, unknown), /已有重启 4/);
  const reset = { ...before, pods: [pod("removed", 0), pod("stays")] };
  assert.match(deltaText(before, reset), /重启计数回退/);
});

test("compact environment deltas retain worsening, recovery and changed runtime image evidence", () => {
  const before = { ...workload("tag"), pods: [pod("one")] };
  const crashed = { ...before, ready: 0, pods: [{ ...pod("one", 1), ready: false, containers: [{ ...pod("one", 1).containers[0]!, ready: false,
    state: "waiting", reason: "CrashLoopBackOff", lastExitReason: "OOMKilled" }] }] };
  const text = deltaText(before, crashed);
  assert.match(text, /就绪副本 1\/1 → 0\/1/);
  assert.match(text, /CrashLoopBackOff/);
  assert.match(text, /OOMKilled/);
  const recovered = { ...before, pods: [pod("one", 1)] };
  assert.match(deltaText(crashed, recovered), /就绪副本 0\/1 → 1\/1/);
  assert.match(deltaText(crashed, recovered), /CrashLoopBackOff.*→ running/);
  const digestChanged = { ...before, pods: [pod("two", 0, "sha256:b")] };
  assert.match(deltaText(before, digestChanged), /镜像声明未变/);
  assert.match(deltaText(before, digestChanged), /运行镜像标识集合变化/);
});

test("large ordinary Pod turnover has a compact delta without erasing the evidence", () => {
  const before = { ...workload("tag"), desired: 100, ready: 100, pods: Array.from({ length: 100 }, (_, i) => pod(`old-${i}`)) };
  const after = { ...before, pods: Array.from({ length: 100 }, (_, i) => pod(`new-${i}`)) };
  const text = deltaText(before, after);
  assert.ok(text.length < 350);
  assert.match(text, /Pod 新增 100、移除 100/);
  assert.doesNotMatch(text, /api-old|api-new/);
  assert.ok(JSON.stringify({ before, after }).length > text.length * 50);
});
