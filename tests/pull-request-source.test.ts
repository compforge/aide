import jsonPatch from "fast-json-patch";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { PullRequestSnapshot, PullRequestKey, PullRequestScanQuery, PullRequestScanResult, PullRequestScanCursor } from "@compforge/aide-plugin";
import definitions from "../plugins/personal/definitions.ts";
import { HarnessFixtures } from "./harness-fixture.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { personalAdmission } from "../plugins/personal/admission.ts";
import { routeByRules } from "../plugins/personal/route/rules.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "../plugins/personal/topic/model.ts";
import { emptyConnectors } from "../src/connector/client.ts";
import { nextPullRequestPollDelay } from "../plugins/personal/source/pull-request/state.ts";
import { observePullRequests, PULL_REQUEST_SOURCE_TYPE, type PullRequestSourceStatus } from "../plugins/personal/source/pull-request/observe.ts";
import { PullRequestSourceSpecSchema, validateForgeSources, type PullRequestSourceSpec } from "../plugins/personal/source/pull-request/config.ts";
import { Aide } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { createConnectors } from "./connector-fixture.ts";
import { createForgeReader } from "@compforge/repocli";
import { fakeOptions } from "./fake-harness.ts";

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const at = (seconds = 0) => new Date(Date.parse("2026-10-26T00:00:00Z") + seconds * 1000).toISOString();
const pr = (number = 1, path = "org/repo"): PullRequestSnapshot => ({ repository: { forge: { name: "gitlab.test" }, path }, number, title: "Reduce latency",
  url: `https://gitlab.test/${path}/-/merge_requests/${number}`, state: "open", conflictState: "unknown", mergeReadiness: "unknown", headSha: "a" });
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "aide-forge-"));
  const sessions = new HarnessFixtures(root), session = sessions.create({ id: "forge", cwd: root });
  const inputs = new InputStore(root);
  let store = new PluginResourceStore({ home: session.home, pluginInstanceId: "personal" });
  store.storage.register("personal", definitions);
  const client = () => createResourceClient(store, undefined, undefined, personalAdmission(inputs, new OutputStore(session.home)));
  let resources = client();
  const watch = PullRequestSourceSpecSchema.parse({ id: "mine", forge: "gitlab.test", author: "me", intervalMs: 30_000 });
  store.create({ type: PULL_REQUEST_SOURCE_TYPE, name: "watch", spec: watch, status: {} });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  let current = pr(), failure = false;
  let read: (query: PullRequestScanQuery) => Promise<PullRequestScanResult> = async () => ({ items: failure ? [] : [current],
    cursor: "reader-cursor" as PullRequestScanCursor, pending: false, complete: !failure, issues: failure ? [{stage: "get", kind: "auth", message: "Forbidden"}] : [] });
  const connectors = { ...emptyConnectors, forges: { ...emptyConnectors.forges,
    async scanPullRequests(_forge: string, query: PullRequestScanQuery) { return read(query); },
  } };
  const resource = () => store.get<PullRequestSourceSpec, PullRequestSourceStatus>(PULL_REQUEST_SOURCE_TYPE, "watch");
  return { root, inputs, connectors, resource, get resources() { return resources; },
    setPR(value: PullRequestSnapshot) { current = value; }, setRead(fn: typeof read) { read = fn; }, setFailure(value: boolean) { failure = value; },
    observe(seconds = 0) { return observePullRequests({ logger, resources }, resource(), connectors, at(seconds)); },
    async restart() { const reopened = sessions.open(session.id); t.after(() => reopened.closeLogs()); store = new PluginResourceStore({ home: reopened.home, pluginInstanceId: "personal" }); resources = client(); },
  };
}

const scanResult = (items: readonly PullRequestSnapshot[], extra: Partial<PullRequestScanResult> = {}): PullRequestScanResult => ({
  items, cursor: "scan-cursor" as PullRequestScanCursor, pending: false, complete: true, issues: [], ...extra,
});
const merged = (number=1): PullRequestSnapshot => ({...pr(number),state:"merged",mergedAt:at(20)});

test("merged is admitted once while coverage issues survive and successful items are consumed", async t => {
  const f=fixture(t);await f.observe();assert.equal(f.inputs.list().length,0);
  f.setRead(async query=>{
    assert.deepEqual(query.scope,{kind:"account",author:"me"});assert(query.tracked?.some(key=>key.number===1));
    return scanResult([merged()],{pending:true,complete:false,issues:[{stage:"list",kind:"transport",message:"Search unavailable"}]});
  });
  await f.observe(30);assert.equal(f.inputs.list().length,1);
  assert.equal(f.resource().status.scanComplete,false);assert.equal(f.resource().status.issues?.[0]?.kind,"transport");
  assert.equal(f.resource().status.error,null);assert.equal(f.resource().status.cursor,"scan-cursor");
  const input=f.inputs.list()[0]!;assert.equal(input.spec.observation?.kind,"forge.merged");
  assert.equal(input.spec.originRef?.uid,f.resource().metadata.uid);
  f.setRead(async()=>scanResult([merged()]));await f.restart();await f.observe(60);
  assert.equal(f.inputs.list().length,1);assert.deepEqual(f.resource().status.issues,[]);assert.equal(f.resource().status.scanComplete,true);
});

/** @case Repository grouping preserves per-PR occurrences, Forge isolation, and an existing Topic name. */
test("merged inputs share repository Topics while PR baselines and other Forge repositories stay independent", async t => {
  const f = fixture(t);
  const requests = [pr(1), pr(2), pr(1, "org/other"), { ...pr(1), repository: { forge: { name: "other.test" }, path: "org/repo" } }];
  let current = requests;
  f.setRead(async () => scanResult(current));
  await f.observe(); assert.equal(f.inputs.list().length, 0);
  current = requests.map(request => ({ ...request, state: "merged", mergedAt: at(20) }));
  await f.observe(30);
  assert.equal(f.inputs.list().length, 4);
  assert.equal(Object.keys(f.resource().status.snapshot!.value).length, 4);
  const route = async () => {
    for (const input of f.inputs.list()) assert.equal(await routeByRules({ resources: f.resources, logger }, input), true);
  };
  await route();
  const topics = await f.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
  assert.equal(topics.length, 3);
  const shared = topics.find(topic => topic.spec.topicKey === 'forge:["gitlab.test","org/repo"]')!;
  assert.equal(shared.spec.name, "org/repo");
  assert.ok(topics.some(topic => topic.spec.topicKey === 'forge:["gitlab.test","org/other"]'));
  assert.ok(topics.some(topic => topic.spec.topicKey === 'forge:["other.test","org/repo"]'));
  const inputs = f.inputs.list().filter(input => input.spec.topicKey === shared.spec.topicKey);
  assert.equal(inputs.length, 2);
  assert.ok(inputs.every(input => input.status.route!.result!.topics[0]!.uid === shared.metadata.uid && input.spec.topicName === "org/repo"));
  assert.ok(inputs.some(input => input.spec.text.includes("#1")));
  assert.ok(inputs.some(input => input.spec.text.includes("#2")));
  await f.resources.replace(shared, { ...shared.spec, name: "Project progress" }, shared.status);
  current = [requests[0]!, ...current.slice(1)]; await f.observe(40);
  current = [{ ...merged(), mergedAt: at(50) }, ...current.slice(1)]; await f.observe(60);
  assert.equal(f.inputs.list().length, 5, "Re-merging one PR is a new occurrence; other merged PRs are not replayed");
  await route();
  const latest = (await f.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE)).find(topic => topic.metadata.uid === shared.metadata.uid)!;
  assert.equal(latest.spec.name, "Project progress");
  assert.equal(f.inputs.list().filter(input => input.status.route!.result!.topics[0]!.uid === shared.metadata.uid).length, 3);
  await f.restart(); await f.observe(90);
  assert.equal(f.inputs.list().length, 5);
});

test("crash after Input persistence preserves the frozen plan and does not emit another merge for a new revision",async t=>{
  const f=fixture(t);await f.observe();f.setPR(merged());
  const interrupted:typeof f.resources={...f.resources,async patch(resource, value, options) {
    const patch = (value.type === "json" ? jsonPatch.applyPatch(structuredClone(resource), value.value as jsonPatch.Operation[]).newDocument.status : value.value.status) as Record<string, any>;
    if("pending" in patch && patch.pending===null)throw new Error("Interrupted after Input");
    return f.resources.patch(resource, value, options);
  }};
  await assert.rejects(observePullRequests({logger,resources:interrupted},f.resource(),f.connectors,at(30)),/Interrupted/);
  assert.equal(f.inputs.list().length,1);assert(f.resource().status.pending);
  const frozen=f.inputs.list()[0]!.spec;
  f.setPR({...merged(),headSha:"newer"});await f.restart();await f.observe(60);await f.observe(90);
  assert.equal(f.inputs.list().length,1);assert.deepEqual(f.inputs.list()[0]!.spec,frozen);
  assert.equal(f.resource().status.pending,null);assert.equal(Object.values(f.resource().status.snapshot!.value)[0]!.snapshot.headSha,"newer");
});

test("open revisions, titles, close and reopen update baselines silently; each later merge is an occurrence",async t=>{
  const f=fixture(t);await f.observe();
  for(const [i,headSha] of ["b","a","b"].entries()){f.setPR({...pr(),headSha,title:"Updated"});await f.observe(i+1);}
  f.setPR({...pr(),state:"closed"});await f.observe(10);f.setPR(pr());await f.observe(20);
  assert.equal(f.inputs.list().length,0);
  f.setPR(merged());await f.observe(30);f.setPR({...merged(),updatedAt:at(40),baseSha:"moving"});await f.observe(40);
  assert.equal(f.inputs.list().length,1);
  f.setPR(pr());await f.observe(50);f.setPR(merged());await f.observe(60);
  assert.equal(f.inputs.list().length,2);assert.equal(f.resource().status.sequence,2);
});

test("frozen batch resumes at its offset and commits the opaque scan cursor only after all merges",async t=>{
  const f=fixture(t);let reads=0;
  f.setRead(async()=>{reads++;return scanResult([merged(1),merged(2)]);});
  const interrupted:typeof f.resources={...f.resources,async patch(resource, value, options) {
    const patch = (value.type === "json" ? jsonPatch.applyPatch(structuredClone(resource), value.value as jsonPatch.Operation[]).newDocument.status : value.value.status) as Record<string, any>;
    if("batch" in patch && (patch.batch as {offset:number}|null)?.offset===1)throw new Error("between items");
    return f.resources.patch(resource, value, options);
  }};
  await assert.rejects(observePullRequests({logger,resources:interrupted},f.resource(),f.connectors,at(30)),/between items/);
  assert.equal(f.inputs.list().length,1);assert.equal(f.resource().status.cursor,undefined);
  await f.restart();await f.observe(60);
  assert.equal(reads,1);assert.equal(f.inputs.list().length,2);assert.equal(f.resource().status.cursor,"scan-cursor");
});

test("partial failures retain baselines without blocking a later merge", async t => {
  const f = fixture(t); await f.observe(); const baseline = f.resource().status.snapshot?.value;
  f.setFailure(true); await f.observe(30); assert.deepEqual(f.resource().status.snapshot?.value, baseline);
  f.setRead(async () => scanResult([merged(2)], { complete: false, issues: [{ stage: "get", kind: "not_found", message: "1 missing", key: pr(1) }] }));
  await f.observe(60); assert.equal(f.inputs.list().length, 1);
  assert.equal(f.resource().status.snapshot?.value[JSON.stringify(["gitlab.test", "org/repo", 1])]!.snapshot.state, "open");
});

test("source scheduling distinguishes pending work, coverage gaps and rate-limit backoff",()=>{
  assert.equal(nextPullRequestPollDelay({cursor:"c" as PullRequestScanCursor,scanPending:true,issues:[{stage:"get",kind:"not_found",message:"missing"}]},30_000),1000);
  assert.equal(nextPullRequestPollDelay({cursor:"c" as PullRequestScanCursor,scanPending:false,scanComplete:false},30_000),30_000);
  assert.equal(nextPullRequestPollDelay({scanPending:true,issues:[{stage:"list",kind:"rate_limit",message:"limited",retryAfterMs:120_000}]},30_000),120_000);
  assert.equal(nextPullRequestPollDelay({batch:{} as never,error:"Input failed"},30_000),30_000);
});

test("expired baselines and missing merge times do not replay historical merges",async t=>{
  const f=fixture(t);f.setPR({...pr(),state:"merged"});await f.observe();assert.equal(f.inputs.list().length,0);
  f.setPR(merged(2));await f.observe(30);assert.equal(f.inputs.list().length,1);
  f.setRead(async()=>scanResult([]));await f.observe(9*86400);
  assert.equal(Object.keys(f.resource().status.snapshot?.value!).length,0);
  f.setRead(async()=>scanResult([merged(2)]));await f.observe(9*86400+30);assert.equal(f.inputs.list().length,1);
});

test("configured accounts stay explicit and unique",()=>{
  const watch=PullRequestSourceSpecSchema.parse({id:"mine",forge:"gitlab.test",author:"me"});
  assert.equal(watch.intervalMs,300_000);assert.throws(()=>PullRequestSourceSpecSchema.parse({...watch,author:"me is:merged"}));
  assert.throws(()=>validateForgeSources([], [watch],[]),/unknown connector/);
  assert.throws(()=>validateForgeSources([], [watch,{...watch,id:"duplicate"}],[{forge:watch.forge}]),/Duplicate/);
});

test("real Runner discovers across IPC and routes a merged Input to Chief; disabled Source stays idle", { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "aide-forge-runner-"));
  let current = pr(); let discoveries = 0; const prompts: string[] = [];
  const connectors = createConnectors([], [{forge:"gitlab.test",provider:"gitlab" as const,host:"gitlab.test",token:"fixture"},{forge:"unavailable.test",provider:"gitlab" as const,host:"unavailable.test",token:"fixture"}].map(config => createForgeReader(config, {fetch: async input => {
      const url = new URL(String(input));
      if (url.hostname === "unavailable.test") return new Response("Unavailable", {status: 503});
      const mr = { iid: current.number, title: current.title, web_url: current.url, state: current.state === "open" ? "opened" : current.state,
        sha: current.headSha, author: { username: "me" } };
      if (url.pathname === "/api/v4/merge_requests") { discoveries++; return Response.json([mr]); }
      if (url.pathname.endsWith("/discussions")) return Response.json([]);
      return Response.json(mr);
    }})));
  const config = ConfigSchema.parse({ connectors: {"gitlab.test": {kind:"forge",version:"v1",config:{provider:"gitlab",host:"gitlab.test",forge:"gitlab.test"}},"unavailable.test": {kind:"forge",version:"v1",config:{provider:"gitlab",host:"unavailable.test",forge:"unavailable.test"}}},
    plugins: { personal: { weave: { enabled: false }, sources: { pullRequests: [{ id: "mine", forge: "gitlab.test", author: "me" }, {id: "unavailable", forge: "unavailable.test", author: "me"}] } } } });
  const agent = { notify: false, async chief(prompt: string) { prompts.push(prompt); return "Recorded"; }, async execute(): Promise<never> { throw new Error("No work was delegated"); } };
  let aide = new Aide(root, { ...fakeOptions(agent, root), connectors, config }, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const inputs = new InputStore(root);
  const until = async (condition: () => boolean) => { const deadline = Date.now() + 10_000; while (!condition()) {
    if (Date.now() > deadline) throw new Error("Forge Source/Chief did not settle");
    await new Promise(r => setTimeout(r, 20));
  } };
  const sourceStore = new PluginResourceStore({ home: root, pluginInstanceId: "personal" });
  await aide.start(); await until(() => Object.keys(sourceStore.list<PullRequestSourceSpec, PullRequestSourceStatus>(PULL_REQUEST_SOURCE_TYPE).find(source => source.spec.id === "mine")?.status.snapshot?.value ?? {}).length === 1);
  assert.equal(inputs.list().length, 0);
  current = { ...current, state: "merged", headSha: "b" };
  const store = new PluginResourceStore({ home: root, pluginInstanceId: "personal" });
  const source = store.list<PullRequestSourceSpec, PullRequestSourceStatus>(PULL_REQUEST_SOURCE_TYPE).find(source => source.spec.id === "mine")!;
  await aide.runtime.enqueue("personal", PULL_REQUEST_SOURCE_TYPE, source.metadata.name);
  await until(() => inputs.list().filter(i => i.status.assess?.completedAt).length === 1);
  assert(sourceStore.list<PullRequestSourceSpec, PullRequestSourceStatus>(PULL_REQUEST_SOURCE_TYPE).find(source => source.spec.id === "unavailable")?.status.issues?.length);
  assert.ok(prompts.some(p => p.includes("merged"))); assert.equal(aide.topics.list().filter(c => !c.default).length, 1);
  assert.equal(aide.personal.store.read().works.length, 0);
  await aide.close(); const before = discoveries;
  aide = new Aide(root, { ...fakeOptions(agent, root), connectors, config: ConfigSchema.parse({ connectors: config.connectors }) }, pino({ level: "silent" }));
  await aide.start(); await aide.settled(); assert.equal(discoveries, before);
});


test("a frozen batch retains its acceptance horizon across a long interruption",async t=>{
  const f=fixture(t);f.setRead(async()=>scanResult([merged(1),merged(2)]));
  const interrupted:typeof f.resources={...f.resources,async patch(resource, value, options) {
    const patch = (value.type === "json" ? jsonPatch.applyPatch(structuredClone(resource), value.value as jsonPatch.Operation[]).newDocument.status : value.value.status) as Record<string, any>;
    if("batch" in patch && (patch.batch as {offset:number}|null)?.offset===1)throw new Error("between items");
    return f.resources.patch(resource, value, options);
  }};
  await assert.rejects(observePullRequests({logger,resources:interrupted},f.resource(),f.connectors,at(30)),/between items/);
  await f.restart();await f.observe(9*86400);
  assert.equal(f.inputs.list().length,2);assert.equal(f.resource().status.cursor,"scan-cursor");
});



test("a retired observer drains frozen Inputs and batches without another Forge request", async t => {
  const f = fixture(t); f.setRead(async () => scanResult([merged(1), merged(2)]));
  const interrupted: typeof f.resources = { ...f.resources, async patch(resource, value, options) {
    const patch = (value.type === "json" ? jsonPatch.applyPatch(structuredClone(resource), value.value as jsonPatch.Operation[]).newDocument.status : value.value.status) as Record<string, any>;
    if ("pending" in patch && patch.pending === null) throw new Error("stop after Input");
    return f.resources.patch(resource, value, options);
  } };
  await assert.rejects(observePullRequests({ logger, resources: interrupted }, f.resource(), f.connectors, at(30)), /stop after Input/);
  assert(f.resource().status.pending); assert.equal(f.inputs.list().length, 1);
  f.setRead(async () => { throw new Error("Retired observer must not read"); });
  await f.restart();
  await observePullRequests({ logger, resources: f.resources }, f.resource(), f.connectors, at(60), false);
  assert.equal(f.inputs.list().length, 2); assert.equal(f.resource().status.batch, null);
  assert.equal(f.resource().status.pending, null); assert.equal(f.resource().status.retiredAt, at(60));
});
