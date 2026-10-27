import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { Page, PageQuery, RepositorySnapshot } from "@compforge/aide-plugin";
import { parsePersonalConfig } from "../plugins/personal/config.ts";
import definitions from "../plugins/personal/definitions.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { emptyConnectors } from "../src/connector-client.ts";
import { RepositoryWatchSchema, RepositorySourceSpecSchema, type RepositorySourceSpec } from "../plugins/personal/source/repository/config.ts";
import { REPOSITORY_SOURCE_TYPE } from "../plugins/personal/source/repository/definition.ts";
import { observeRepositories } from "../plugins/personal/source/repository/observe.ts";
import type { RepositorySourceStatus } from "../plugins/personal/source/repository/state.ts";
import { PullRequestWatchSchema, validateForgeSources, type PullRequestSourceSpec } from "../plugins/personal/source/pull-request/config.ts";
import { PULL_REQUEST_SOURCE_TYPE } from "../plugins/personal/source/pull-request/definition.ts";
import { pullRequestSourceActive } from "../plugins/personal/source/pull-request/observe.ts";
import type { PullRequestSourceStatus } from "../plugins/personal/source/pull-request/state.ts";
import { Aide } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { createConnectors } from "./connector-fixture.ts";
import { createForgeReader } from "@compforge/repocli";
import { fakeOptions } from "./fake-harness.ts";
import { InputStore } from "../plugins/personal/input/store.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const at = (seconds = 0) => new Date(Date.parse("2026-10-26T00:00:00Z") + seconds * 1000).toISOString();
const repo = (path: string): RepositorySnapshot => ({ forge: { name: "work" }, path });
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "aide-repositories-"));
  const open = () => { const store = new PluginResourceStore({ home: root, pluginInstanceId: "personal" }); store.storage.register("personal", definitions); return store; };
  let store = open(), resources = createResourceClient(store);
  const watch = RepositorySourceSpecSchema.parse({ id: "repos", forge: "work", refreshIntervalMs: 60_000, connectionRevision: "" });
  const policy = PullRequestWatchSchema.parse({ id: "mine", repositories: "repos", author: "me" });
  store.create({ type: REPOSITORY_SOURCE_TYPE, name: "repos", spec: watch, status: {} });
  let reads = 0, read: (query?: PageQuery) => Promise<Page<RepositorySnapshot>> = async () => ({ items: [repo("org/a")] });
  const connectors = { ...emptyConnectors, forges: { ...emptyConnectors.forges, async listRepositories(_forge: string, query?: PageQuery) { reads++; return read(query); } } };
  const resource = () => store.get<RepositorySourceSpec, RepositorySourceStatus>(REPOSITORY_SOURCE_TYPE, "repos");
  const children = () => store.list<PullRequestSourceSpec, PullRequestSourceStatus>(PULL_REQUEST_SOURCE_TYPE);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, watch, policy, resource, children, connectors, get resources() { return resources; }, get reads() { return reads; },
    setRead(fn: typeof read) { read = fn; },
    observe(seconds = 0) { return observeRepositories({ resources, logger }, resource(), connectors, [policy], at(seconds)); },
    restart() { store = open(); resources = createResourceClient(store); },
  };
}

test("repository inventory publishes after complete pagination and survives a restart without another read", async t => {
  const f = fixture(t);
  f.setRead(async query => query?.cursor ? { items: [repo("org/b"), repo("org/a")] } : { items: [repo("org/a")], nextCursor: "page2" });
  assert.equal(await f.observe(), 1000);
  assert.equal(f.resource().status.snapshot, undefined); assert.equal(f.children().length, 0);
  assert.equal(f.resource().status.refresh?.cursor, "page2");
  f.restart(); await f.observe(1);
  assert.equal(f.resource().status.snapshot?.value.length, 2); assert.equal(f.children().length, 2);
  const ids = f.children().map(c => c.metadata.uid).sort();
  f.restart(); await f.observe(30);
  assert.equal(f.reads, 2); assert.deepEqual(f.children().map(c => c.metadata.uid).sort(), ids);
});

test("failed and incomplete refreshes keep the complete inventory and respect backoff", async t => {
  const f = fixture(t); await f.observe(); const snapshot = f.resource().status.snapshot;
  f.setRead(async () => ({ items: [repo("org/b")], nextCursor: "next" })); await f.observe(61);
  f.setRead(async () => { throw new Error("network interrupted"); });
  await assert.rejects(f.observe(62), /network interrupted/);
  assert.deepEqual(f.resource().status.snapshot, snapshot); assert.equal(f.resource().status.refresh?.cursor, "next");
  f.restart(); f.setRead(async () => ({ items: [], issues: [{ stage: "list", kind: "rate_limit", message: "wait", retryAfterMs: 120_000 }] }));
  assert.equal(await f.observe(63), 120_000);
  assert.deepEqual(f.resource().status.snapshot, snapshot); assert.equal(f.children().length, 1);
  const reads = f.reads; await f.observe(100); assert.equal(f.reads, reads);
  f.setRead(async query => { assert.equal(query?.cursor, undefined); return { items: [repo("org/b")] }; });
  await f.observe(184); assert.deepEqual(f.resource().status.snapshot?.value, [repo("org/b")]);
});

test("child creation resumes after persistence before offset commit, with bounded fanout", async t => {
  const f = fixture(t); f.setRead(async () => ({ items: Array.from({ length: 25 }, (_, i) => repo(`org/r${i}`)) }));
  const interrupted: typeof f.resources = { ...f.resources, async patchStatus(resource, patch) {
    if ((patch as Partial<RepositorySourceStatus>).handoff?.offset === 1) throw new Error("handoff interrupted");
    return f.resources.patchStatus(resource, patch);
  } };
  await assert.rejects(observeRepositories({ resources: interrupted, logger }, f.resource(), f.connectors, [f.policy], at()), /handoff interrupted/);
  assert.equal(f.children().length, 1); const first = f.children()[0]!.metadata.uid;
  f.restart(); assert.equal(await f.observe(1), 1000); assert.equal(f.children().length, 20);
  assert.equal(f.children().find(c => c.metadata.uid === first)?.metadata.uid, first);
  assert.equal(await f.observe(2), 58_000); assert.equal(f.children().length, 25);
  assert.equal(f.resource().status.handoff, null); assert.equal(f.reads, 1);
});

test("only a complete inventory removes membership; configured scope and parent UID control observers", async t => {
  const f = fixture(t); await f.observe(); const child = f.children()[0]!;
  const active = () => pullRequestSourceActive({ resources: f.resources }, child, [f.policy], [f.watch]);
  assert.equal(await active(), true);
  f.setRead(async () => ({ items: [], nextCursor: "page2" })); await f.observe(61); assert.equal(await active(), true);
  f.setRead(async () => ({ items: [] })); await f.observe(62); assert.equal(await active(), false);
  f.setRead(async () => ({ items: [repo("org/a")] })); await f.observe(123); assert.equal(await active(), true);
  assert.equal(f.children().length, 1);
  assert.equal(await pullRequestSourceActive({ resources: f.resources }, child, [], [f.watch]), false);
  assert.equal(await pullRequestSourceActive({ resources: f.resources }, child, [f.policy], []), false);
  assert.equal(await pullRequestSourceActive({ resources: f.resources }, { ...child, spec: { ...child.spec, repositorySource: { name: "repos", uid: "replaced" } } }, [f.policy], [f.watch]), false);
});

test("cached inventories reconcile new policies without a provider request", async t => {
  const f = fixture(t); await f.observe();
  const added = PullRequestWatchSchema.parse({ id: "colleague", repositories: "repos", author: "other" });
  await observeRepositories({ resources: f.resources, logger }, f.resource(), f.connectors, [f.policy, added], at(30));
  assert.equal(f.children().length, 2); assert.equal(f.reads, 1);
});

test("configuration rejects unknown inventories, duplicate discovery scopes and obsolete forges", () => {
  const inventory = RepositoryWatchSchema.parse({ id: "repos", forge: "work" });
  const policy = PullRequestWatchSchema.parse({ id: "mine", repositories: "repos", author: "me" });
  validateForgeSources([inventory], [policy], [{ forge: "work" }]);
  assert.throws(() => validateForgeSources([], [policy], [{ forge: "work" }]), /unknown Repository Source/);
  assert.throws(() => validateForgeSources([inventory, { ...inventory, id: "duplicate" }], [], [{ forge: "work" }]), /Duplicate/);
  const direct = PullRequestWatchSchema.parse({ id: "account", forge: "work", author: "me" });
  assert.throws(() => validateForgeSources([inventory], [policy, direct], [{ forge: "work" }]), /Duplicate/);
  assert.throws(() => parsePersonalConfig({ sources: { forges: [] } }));
});

test("Runner builds repository observers over IPC; a failed repository does not prevent merged Input delivery", { timeout: 25_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "aide-repository-runner-"));
  let merged = false, inventories = 0; const prompts: string[] = [];
  const connectors = createConnectors([], [createForgeReader({forge:"work",provider:"gitlab",host:"gitlab.test",token:"fixture"}, {fetch: async input => {
      const url = new URL(String(input));
      if (url.pathname === "/api/v4/projects") { inventories++; return Response.json([{ path_with_namespace: "org/healthy" }, { path_with_namespace: "org/broken" }]); }
      if (url.pathname.includes("broken")) return new Response("Unavailable", { status: 503 });
      if (url.pathname === "/api/v4/merge_requests") throw new Error("Repository mode must not use account discovery");
      const mr = { iid: 1, title: "Scoped observation", web_url: "https://gitlab.test/org/healthy/-/merge_requests/1", state: merged ? "merged" : "opened", sha: "head", author: { username: "me" } };
      if (url.pathname.endsWith("/merge_requests")) { assert.equal(url.searchParams.get("author_username"), "me"); return Response.json([mr]); }
      return Response.json(mr);
    }})]);
  const config = ConfigSchema.parse({ connectors: {work: {kind:"forge",version:"v1",config:{provider:"gitlab",host:"gitlab.test",forge:"work"}}}, plugins: { personal: { weave: { enabled: false }, sources: {
    repositories: [{ id: "repos", forge: "work" }], pullRequests: [{ id: "mine", repositories: "repos", author: "me" }],
  } } } });
  const agent = { notify: false, async chief(prompt: string) { prompts.push(prompt); return "Recorded"; }, async execute(): Promise<never> { throw new Error("No delegated work"); } };
  let aide = new Aide(root, { ...fakeOptions(agent, root), connectors, config }, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const store = new PluginResourceStore({ home: root, pluginInstanceId: "personal" });
  const inputs = new InputStore(root);
  const until = async (condition: () => boolean) => { const end = Date.now() + 12_000; while (!condition()) { if (Date.now() > end) throw new Error("Repository pipeline did not settle"); await new Promise(r => setTimeout(r, 20)); } };
  const sources = () => store.list<PullRequestSourceSpec, PullRequestSourceStatus>(PULL_REQUEST_SOURCE_TYPE);
  await aide.start();
  await until(() => sources().some(s => s.spec.repository?.path === "org/healthy" && Object.keys(s.status.snapshot?.value ?? {}).length === 1));
  const healthy = sources().find(s => s.spec.repository?.path === "org/healthy")!;
  assert.equal(inputs.list().length, 0); merged = true;
  await aide.runtime.enqueue("personal", PULL_REQUEST_SOURCE_TYPE, healthy.metadata.name);
  await until(() => inputs.list().some(i => Object.values(i.status.assess ?? {}).some(a => a.completedAt)));
  await until(() => sources().some(s => s.spec.repository?.path === "org/broken" && Boolean(s.status.issues?.length)));
  assert.equal(inputs.list().length, 1); assert(prompts.some(p => p.includes("merged"))); assert.equal(inventories, 1);
  await aide.close();
  aide = new Aide(root, { ...fakeOptions(agent, root), connectors, config }, pino({ level: "silent" }));
  await aide.start(); await aide.settled();
  assert.equal(inventories, 1); assert.equal(sources().length, 2); assert.equal(inputs.list().length, 1);
});

test("re-enabling a cached Repository Source clears retirement without another external request", async t => {
  const f = fixture(t); await f.observe();
  await f.resources.patchStatus(f.resource(), { retiredAt: at(1) });
  await f.observe(2);
  assert.equal(f.resource().status.retiredAt, null); assert.equal(f.reads, 1);
  const child = f.children()[0]!;
  assert.equal(await pullRequestSourceActive({ resources: f.resources }, child, [f.policy], [{ ...f.watch, connectionRevision: "changed" }]), false);
});

test("changing a PR polling policy preserves its resource identity and checkpoint", async t => {
  const f = fixture(t); await f.observe();
  const before = f.children()[0]!;
  await f.resources.patchStatus(before, { sequence: 7 });
  const policy = { ...f.policy, intervalMs: 60_000 };
  await observeRepositories({ resources: f.resources, logger }, f.resource(), f.connectors, [policy], at(30));
  assert.equal(f.children().length, 1);
  const after = f.children()[0]!;
  assert.equal(after.metadata.uid, before.metadata.uid); assert.equal(after.status.sequence, 7);
  assert.equal(after.spec.intervalMs, 60_000); assert.equal(f.reads, 1);
});
