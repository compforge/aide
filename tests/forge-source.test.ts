import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { PullRequestObservation, PullRequestKey, PullRequestDiscoveryQuery, PullRequestPage } from "@compforge/aide-plugin";
import definitions from "../plugins/personal/definitions.ts";
import { HarnessFixtures } from "./harness-fixture.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { personalAdmission } from "../plugins/personal/admission.ts";
import { emptyConnectors } from "../src/connector-client.ts";
import { observeForge, FORGE_SOURCE_TYPE, type ForgeSourceStatus } from "../plugins/personal/source/forge/observe.ts";
import { ForgeWatchSchema, forgeWatches, type ForgeWatch } from "../plugins/personal/source/forge/config.ts";
import { Aide } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { Connectors } from "../connectors/index.ts";
import { createForgeConnectors } from "../connectors/forge/config.ts";
import { fakeOptions } from "./fake-harness.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const at = (seconds = 0) => new Date(Date.parse("2026-10-26T00:00:00Z") + seconds * 1000).toISOString();
const pr = (number = 1, path = "org/repo"): PullRequestObservation => ({ repository: { forge: { name: "gitlab.test" }, path }, number, title: "Reduce latency",
  url: `https://gitlab.test/${path}/-/merge_requests/${number}`, state: "open", reviewThreads: "none", mergeability: "unknown", headSha: "a", observedAt: at() });
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "aide-forge-"));
  const sessions = new HarnessFixtures(root), session = sessions.create({ id: "forge", cwd: root });
  const inputs = new InputStore(root);
  let store = new PluginResourceStore({ home: session.home, pluginInstanceId: "personal" });
  store.storage.register("personal", definitions);
  const client = () => createResourceClient(store, undefined, undefined, personalAdmission(inputs, new OutputStore(session.home)));
  let resources = client();
  const watch = ForgeWatchSchema.parse({ id: "mine", forge: "gitlab.test", author: "me", intervalMs: 30_000 });
  store.create({ type: FORGE_SOURCE_TYPE, name: "watch", spec: watch, status: {} });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  let current = pr(), failure = false;
  let discover: (query: PullRequestDiscoveryQuery) => Promise<PullRequestPage> = async () => ({ items: [{ repository: current.repository, number: current.number }] });
  const connectors = { ...emptyConnectors, forges: { ...emptyConnectors.forges,
    async discover(_forge: string, query: PullRequestDiscoveryQuery) { return discover(query); },
    async get(identity: PullRequestKey) { if (failure) throw new Error("Forbidden"); return { ...current, repository: identity.repository, number: identity.number }; },
  } };
  const resource = () => store.get<ForgeWatch, ForgeSourceStatus>(FORGE_SOURCE_TYPE, "watch");
  return { root, inputs, connectors, resource, get resources() { return resources; },
    setPR(value: PullRequestObservation) { current = value; }, setDiscovery(fn: typeof discover) { discover = fn; }, setFailure(value: boolean) { failure = value; },
    observe(seconds = 0) { return observeForge({ logger, resources }, resource(), connectors, at(seconds)); },
    async restart() { const reopened = sessions.open(session.id); t.after(() => reopened.closeLogs()); store = new PluginResourceStore({ home: reopened.home, pluginInstanceId: "personal" }); resources = client(); },
  };
}

test("merged is emitted once even after an MR disappears from discovery, including discovery failure", async t => {
  const f = fixture(t); await f.observe();
  f.setDiscovery(async () => { throw new Error("Search unavailable"); });
  f.setPR({ ...pr(), state: "merged", mergedAt: at(20) });
  await assert.rejects(f.observe(30), /Search unavailable/);
  const merged = f.inputs.list().filter(i => i.spec.text.includes("open → merged"));
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.spec.originId, "personal.forges");
  assert.equal(merged[0]!.spec.topicKey, f.inputs.list()[0]!.spec.topicKey);
  assert.equal(merged[0]!.spec.originRef!.uid, f.resource().metadata.uid);
  f.setDiscovery(async () => ({ items: [] })); await f.restart(); await f.observe(60); await f.observe(90);
  assert.equal(f.inputs.list().length, 2);
});

test("a crash after Input persistence recovers the frozen transition before observing a newer revision", async t => {
  const f = fixture(t);
  const failing: typeof f.resources = { ...f.resources, async patchStatus(current, patch) {
    if ("pending" in patch && patch.pending === null) throw new Error("Interrupted after Input");
    return f.resources.patchStatus(current, patch);
  } };
  await assert.rejects(observeForge({ logger, resources: failing }, f.resource(), f.connectors, at()), /Interrupted/);
  assert.equal(f.inputs.list().length, 1); assert.ok(f.resource().status.pending);
  f.setPR({ ...pr(), headSha: "b", state: "merged" }); await f.restart(); await f.observe(30);
  assert.equal(f.inputs.list().length, 2); assert.equal(f.resource().status.pending, null);
  const change = f.inputs.list().find(i => i.spec.observation?.kind === "forge.changed")!;
  assert.equal((change.spec.observation!.previous as PullRequestObservation).headSha, "a");
  assert.equal((change.spec.observation!.pullRequest as PullRequestObservation).headSha, "b");
  await f.observe(60); assert.equal(f.inputs.list().length, 2);
});

test("revision A-B-A-B and close/reopen/merge are occurrences; polling timestamps are not changes", async t => {
  const f = fixture(t); await f.observe();
  for (const [i, sha] of ["b", "a", "b"].entries()) { f.setPR({ ...pr(), headSha: sha }); await f.observe(i + 1); }
  assert.equal(f.inputs.list().length, 4);
  f.setPR({ ...pr(), headSha: "b", observedAt: at(10), updatedAt: at(10) }); await f.observe(10);
  assert.equal(f.inputs.list().length, 4);
  for (const [i, state] of (["closed", "open", "merged"] as const).entries()) { f.setPR({ ...pr(), headSha: "b", state }); await f.observe(20 + i); }
  assert.equal(f.inputs.list().length, 7);
  assert.equal(new Set(f.inputs.list().map(i => i.metadata.name)).size, 7);
});

test("discovery retains the window and page across restart; identical numbers in different repositories stay distinct", async t => {
  const f = fixture(t); const queries: PullRequestDiscoveryQuery[] = [];
  await f.resources.patchStatus(f.resource(), { initialized: true });
  f.setDiscovery(async q => { queries.push(q); return q.cursor ? { items: [pr(1, "other/repo")] } : { items: [pr()], nextCursor: "2" }; });
  await f.observe(); assert.equal(f.resource().status.scan?.query.cursor, "2"); assert.equal(f.resource().status.scannedThrough, undefined);
  await f.restart(); await f.observe(30);
  assert.equal(queries[1]!.updatedBefore, at()); assert.equal(f.resource().status.scannedThrough, at());
  assert.equal(f.inputs.list().length, 2); assert.equal(new Set(f.inputs.list().map(i => i.spec.topicKey)).size, 2);
});

test("a failed PR read retains the baseline and page; later merge remains observable", async t => {
  const f = fixture(t); await f.observe(); const baseline = f.resource().status.tracked;
  f.setPR({ ...pr(), state: "merged" }); f.setFailure(true);
  await assert.rejects(f.observe(30), /Forbidden/); assert.deepEqual(f.resource().status.tracked, baseline);
  assert.equal(f.resource().status.scan?.offset, 0);
  f.setFailure(false); await f.observe(60); assert.equal(f.inputs.list().length, 2);
});

test("configured account scopes are explicit and unique", () => {
  const watch = ForgeWatchSchema.parse({ id: "mine", forge: "gitlab.test", author: "me" });
  assert.equal(watch.intervalMs, 300_000);
  assert.throws(() => ForgeWatchSchema.parse({ ...watch, author: "me is:merged" }));
  assert.throws(() => forgeWatches([watch], []), /unknown connector/);
  assert.throws(() => forgeWatches([watch, { ...watch, id: "duplicate" }], [{ forge: watch.forge }]), /Duplicate/);
});

test("real Runner discovers across IPC and routes a merged Input to Chief; disabled Source stays idle", { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "aide-forge-runner-"));
  let current = pr(); let discoveries = 0; const prompts: string[] = [];
  const connectors = new Connectors([], createForgeConnectors({ forges: { "gitlab.test": { type: "gitlab", token: "fixture" } } }, {
    environment: {}, fetch: async input => {
      const url = new URL(String(input));
      const mr = { iid: current.number, title: current.title, web_url: current.url, state: current.state === "open" ? "opened" : current.state,
        sha: current.headSha, author: { username: "me" } };
      if (url.pathname === "/api/v4/merge_requests") { discoveries++; return Response.json([mr]); }
      if (url.pathname.endsWith("/discussions")) return Response.json([]);
      return Response.json(mr);
    },
  }));
  const config = ConfigSchema.parse({ connectors: { forges: { "gitlab.test": { type: "gitlab" } } },
    plugins: { personal: { weave: { enabled: false }, sources: { forges: [{ id: "mine", forge: "gitlab.test", author: "me" }] } } } });
  const agent = { notify: false, async chief(prompt: string) { prompts.push(prompt); return "Recorded"; }, async execute(): Promise<never> { throw new Error("No work was delegated"); } };
  let aide = new Aide(root, { ...fakeOptions(agent, root), connectors, config }, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const inputs = new InputStore(root);
  const until = async (condition: () => boolean) => { const deadline = Date.now() + 10_000; while (!condition()) {
    if (Date.now() > deadline) throw new Error("Forge Source/Chief did not settle");
    await new Promise(r => setTimeout(r, 20));
  } };
  await aide.start(); await until(() => inputs.list().some(i => Object.values(i.status.assess ?? {}).some(a => a.completedAt)));
  current = { ...current, state: "merged", headSha: "b" };
  const store = new PluginResourceStore({ home: root, pluginInstanceId: "personal" });
  const source = store.list<ForgeWatch, ForgeSourceStatus>(FORGE_SOURCE_TYPE)[0]!;
  await aide.runtime.enqueue("personal", FORGE_SOURCE_TYPE, source.metadata.name);
  await until(() => inputs.list().filter(i => Object.values(i.status.assess ?? {}).some(a => a.completedAt)).length === 2);
  assert.ok(prompts.some(p => p.includes("merged"))); assert.equal(aide.topics.list().filter(c => !c.default).length, 1);
  assert.equal(aide.personal.store.read().works.length, 0);
  await aide.close(); const before = discoveries;
  aide = new Aide(root, { ...fakeOptions(agent, root), connectors, config: ConfigSchema.parse({ connectors: config.connectors }) }, pino({ level: "silent" }));
  await aide.start(); await aide.settled(); assert.equal(discoveries, before);
});

function legacy(pr: PullRequestObservation) {
  const { repository, number, state, ...facts } = pr;
  return { ...facts, identity: { forge: repository.forge.name, path: repository.path, number }, lifecycle: state };
}

test("legacy checkpoints preserve baselines, page position and Topic identity across upgrade", async t => {
  const f = fixture(t); await f.observe();
  const prior = f.resource().status, key = Object.keys(prior.tracked!)[0]!;
  await f.resources.patchStatus(f.resource(), {
    tracked: { [key]: { ...prior.tracked![key], snapshot: legacy(pr()), fingerprint: "old-format" } },
    scan: { query: { author: "me", state: "all", updatedBefore: at(30) }, page: { items: [legacy(pr(99)).identity, legacy(pr()).identity] }, offset: 1 },
  } as unknown as Partial<ForgeSourceStatus>);
  await f.restart(); await f.observe(30);
  assert.equal(f.inputs.list().length, 1); assert.equal(f.resource().status.sequence, 1);
  assert.equal(f.resource().status.scannedThrough, at(30));
  assert.equal(f.resource().status.tracked![key]!.snapshot.state, "open");
  assert.equal("identity" in f.resource().status.tracked![key]!.snapshot, false);
  f.setDiscovery(async () => ({ items: [] })); f.setPR({ ...pr(), state: "merged" });
  await f.observe(60);
  const inputs = f.inputs.list(); assert.equal(inputs.length, 2);
  assert.equal(inputs[0]!.spec.topicKey, inputs[1]!.spec.topicKey);
  assert.ok(inputs.some(input => input.spec.text.includes("open → merged")));
});

for (const persisted of [false, true]) test(`legacy pending Input survives upgrade (already persisted: ${persisted})`, async t => {
  const f = fixture(t); const snapshot = legacy(pr());
  const key = JSON.stringify([snapshot.identity.forge, snapshot.identity.path, snapshot.identity.number]);
  const name = "frozen-before-upgrade";
  const spec = { topicKey: `forge:${key}`, topicName: "org/repo #1", relation: "observed", attention: "deferred", text: "Frozen observation",
    observation: { kind: "forge.discovered", pullRequest: snapshot } };
  await f.resources.patchStatus(f.resource(), { sequence: 12, initialized: true,
    pending: { name, key, spec, entry: { snapshot, fingerprint: "old-format" } } } as unknown as Partial<ForgeSourceStatus>);
  if (persisted) {
    const failing: typeof f.resources = { ...f.resources, async patchStatus(resource, patch) {
      if ("pending" in patch && patch.pending === null) throw new Error("Interrupted after Input");
      return f.resources.patchStatus(resource, patch);
    } };
    await assert.rejects(observeForge({ logger, resources: failing }, f.resource(), f.connectors, at()), /Interrupted/);
    // Simulate the old process having persisted the Input before leaving its old checkpoint behind.
    await f.resources.patchStatus(f.resource(), { pending: { name, key, spec, entry: { snapshot, fingerprint: "old-format" } } } as unknown as Partial<ForgeSourceStatus>);
  }
  await f.restart(); await f.observe(30); await f.observe(60);
  assert.equal(f.inputs.list().length, 1); assert.equal(f.inputs.list()[0]!.metadata.name, name);
  assert.deepEqual(f.inputs.list()[0]!.spec.observation, spec.observation);
  assert.equal(f.resource().status.sequence, 12); assert.equal(f.resource().status.pending, null);
  f.setPR({ ...pr(), state: "merged" }); await f.observe(90);
  assert.equal(f.inputs.list().length, 2); assert.equal(f.resource().status.sequence, 13);
});

test("snapshot enrichment and diagnostic wording do not manufacture authored changes", async t => {
  const f = fixture(t); await f.observe();
  f.setPR({ ...pr(), sourceBranch: "feature", targetBranch: "main", baseSha: "moving-base", updatedAt: at(30),
    sourceRepository: { forge: { name: "gitlab.test" }, path: "fork/repo" }, reviewError: "review unavailable" });
  await f.observe(30); assert.equal(f.inputs.list().length, 1);
  f.setPR({ ...pr(), reviewThreads: "unknown", reviewError: "review unavailable" });
  await f.observe(60); assert.equal(f.inputs.list().length, 2);
  f.setPR({ ...pr(), reviewThreads: "unknown", reviewError: "a different diagnostic" });
  await f.observe(90); assert.equal(f.inputs.list().length, 2);
});
