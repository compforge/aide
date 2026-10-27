import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { PullRequestSnapshot, PullRequestKey, PullRequestScanQuery, PullRequestScanResult, PullRequestScanCursor } from "@compforge/aide-plugin";
import definitions from "../plugins/personal/definitions.ts";
import { HarnessFixtures } from "./harness-fixture.ts";
import { bindSourceInput, type SourceInput } from "../plugins/personal/source/input.ts";
import { SOURCES } from "../plugins/personal/source/definition.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { personalAdmission } from "../plugins/personal/admission.ts";
import { emptyConnectors } from "../src/connector-client.ts";
import { nextForgePollDelay } from "../plugins/personal/source/forge/state.ts";
import { observeForge, FORGE_SOURCE_TYPE, type ForgeSourceStatus } from "../plugins/personal/source/forge/observe.ts";
import { ForgeWatchSchema, forgeWatches, type ForgeWatch } from "../plugins/personal/source/forge/config.ts";
import { Aide } from "../src/app.ts";
import { ConfigSchema } from "../src/config.ts";
import { Connectors } from "../connectors/index.ts";
import { createForgeConnectors } from "../connectors/forge/config.ts";
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
  const watch = ForgeWatchSchema.parse({ id: "mine", forge: "gitlab.test", author: "me", intervalMs: 30_000 });
  store.create({ type: FORGE_SOURCE_TYPE, name: "watch", spec: watch, status: {} });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  let current = pr(), failure = false;
  let read: (query: PullRequestScanQuery) => Promise<PullRequestScanResult> = async () => ({ items: failure ? [] : [current],
    cursor: "reader-cursor" as PullRequestScanCursor, pending: false, complete: !failure, issues: failure ? [{stage: "get", kind: "auth", message: "Forbidden"}] : [] });
  const connectors = { ...emptyConnectors, forges: { ...emptyConnectors.forges,
    async scanPullRequests(_forge: string, query: PullRequestScanQuery) { return read(query); },
  } };
  const resource = () => store.get<ForgeWatch, ForgeSourceStatus>(FORGE_SOURCE_TYPE, "watch");
  return { root, inputs, connectors, resource, get resources() { return resources; },
    setPR(value: PullRequestSnapshot) { current = value; }, setRead(fn: typeof read) { read = fn; }, setFailure(value: boolean) { failure = value; },
    observe(seconds = 0) { return observeForge({ logger, resources }, resource(), connectors, at(seconds)); },
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

test("crash after Input persistence preserves the frozen plan and does not emit another merge for a new revision",async t=>{
  const f=fixture(t);await f.observe();f.setPR(merged());
  const interrupted:typeof f.resources={...f.resources,async patchStatus(resource,patch){
    if("pending" in patch && patch.pending===null)throw new Error("Interrupted after Input");
    return f.resources.patchStatus(resource,patch);
  }};
  await assert.rejects(observeForge({logger,resources:interrupted},f.resource(),f.connectors,at(30)),/Interrupted/);
  assert.equal(f.inputs.list().length,1);assert(f.resource().status.pending);
  const frozen=f.inputs.list()[0]!.spec;
  f.setPR({...merged(),headSha:"newer"});await f.restart();await f.observe(60);await f.observe(90);
  assert.equal(f.inputs.list().length,1);assert.deepEqual(f.inputs.list()[0]!.spec,frozen);
  assert.equal(f.resource().status.pending,null);assert.equal(Object.values(f.resource().status.tracked!)[0]!.snapshot.headSha,"newer");
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
  const interrupted:typeof f.resources={...f.resources,async patchStatus(resource,patch){
    if("batch" in patch && (patch.batch as {offset:number}|null)?.offset===1)throw new Error("between items");
    return f.resources.patchStatus(resource,patch);
  }};
  await assert.rejects(observeForge({logger,resources:interrupted},f.resource(),f.connectors,at(30)),/between items/);
  assert.equal(f.inputs.list().length,1);assert.equal(f.resource().status.cursor,null);
  await f.restart();await f.observe(60);
  assert.equal(reads,1);assert.equal(f.inputs.list().length,2);assert.equal(f.resource().status.cursor,"scan-cursor");
});

test("partial failures retain baselines and resume seeds without blocking a later merge",async t=>{
  const f=fixture(t);await f.observe();const baseline=f.resource().status.tracked;
  await f.resources.patchStatus(f.resource(),{seed:[pr(1),pr(2)]});
  f.setFailure(true);await f.observe(30);assert.deepEqual(f.resource().status.tracked,baseline);assert.equal(f.resource().status.seed?.length,2);
  f.setRead(async()=>scanResult([merged(2)],{complete:false,issues:[{stage:"get",kind:"not_found",message:"1 missing",key:pr(1)}]}));
  await f.observe(60);assert.deepEqual(f.resource().status.seed?.map(key=>key.number),[1]);assert.equal(f.inputs.list().length,1);
});

test("source scheduling distinguishes pending work, coverage gaps and rate-limit backoff",()=>{
  assert.equal(nextForgePollDelay({cursor:"c" as PullRequestScanCursor,scanPending:true,issues:[{stage:"get",kind:"not_found",message:"missing"}]},30_000),1000);
  assert.equal(nextForgePollDelay({cursor:"c" as PullRequestScanCursor,scanPending:false,scanComplete:false},30_000),30_000);
  assert.equal(nextForgePollDelay({scanPending:true,issues:[{stage:"list",kind:"rate_limit",message:"limited",retryAfterMs:120_000}]},30_000),120_000);
  assert.equal(nextForgePollDelay({batch:{} as never,error:"Input failed"},30_000),30_000);
});

function legacy(value:PullRequestSnapshot){const {repository,number,state,...facts}=value;return {...facts,identity:{forge:repository.forge.name,path:repository.path,number},lifecycle:state,reviewThreads:"none",reviewActivityKey:"old-review"};}

test("legacy identities and reader cursors migrate without changing Topic keys or manufacturing events",async t=>{
  const f=fixture(t);const key=JSON.stringify(["gitlab.test","org/repo",1]);
  await f.resources.patchStatus(f.resource(),{cursor:"v1-opaque" as PullRequestScanCursor,since:at(-86400),sequence:8,
    tracked:{[key]:{snapshot:legacy(pr()),fingerprint:"old"}},
    scan:{query:{updatedAfter:at(-172800)},page:{items:[legacy(pr(99)).identity]},offset:0},
  } as unknown as Partial<ForgeSourceStatus>);
  f.setRead(async query=>{assert.equal(query.cursor,undefined);assert(query.tracked?.some(key=>key.number===99));assert(Date.parse(query.initialSince!)<=Date.parse(at(-172800)));return scanResult([pr()]);});
  await f.restart();await f.observe(30);assert.equal(f.inputs.list().length,0);assert.equal(f.resource().status.sequence,8);
  assert.equal(f.resource().status.schemaVersion,2);assert.equal(f.resource().status.scan,null);
  assert.equal("reviewThreads" in f.resource().status.tracked![key]!.snapshot,false);
  f.setRead(async()=>scanResult([merged()]));await f.observe(60);
  assert.equal(f.inputs.list()[0]!.spec.topicKey,`forge:${key}`);assert.equal(f.resource().status.sequence,9);
});

for(const persisted of [false,true])test(`legacy frozen Input stays immutable through migration (already persisted: ${persisted})`,async t=>{
  const f=fixture(t);const key=JSON.stringify(["gitlab.test","org/repo",1]);
  const snapshot=legacy(pr());const spec={topicKey:`forge:${key}`,topicName:"org/repo #1",relation:"observed",attention:"deferred",text:"Frozen legacy plan",observation:{kind:"forge.changed",pullRequest:snapshot}};
  const pending={name:"frozen-before-upgrade",key,spec,entry:{snapshot,fingerprint:"old"}};
  await f.resources.patchStatus(f.resource(),{sequence:12,pending} as unknown as Partial<ForgeSourceStatus>);
  if(persisted) await bindSourceInput(SOURCES.forges,f.resource(),f.resources)(pending.name,pending.spec as SourceInput);
  await f.restart();await f.observe(30);await f.observe(60);assert.equal(f.inputs.list().length,1);
  assert.equal(f.inputs.list()[0]!.metadata.name,pending.name);assert.deepEqual(f.inputs.list()[0]!.spec.observation,spec.observation);
  assert.equal(f.resource().status.sequence,12);
  f.setPR(merged());await f.observe(90);assert.equal(f.inputs.list().length,2);
});

test("v1 buffered batch drains before new I/O but never commits its old reader cursor",async t=>{
  const f=fixture(t);let reads=0;
  await f.resources.patchStatus(f.resource(),{batch:{offset:1,result:{items:[merged(1),merged(2)],cursor:"old-proposed",pending:false,errors:[]}}} as unknown as Partial<ForgeSourceStatus>);
  f.setRead(async query=>{reads++;assert.equal(query.cursor,undefined);return scanResult([]);});
  await f.observe(30);assert.equal(reads,0);assert.equal(f.inputs.list().length,1);assert.equal(f.resource().status.cursor,null);
  await f.observe(60);assert.equal(reads,1);assert.equal(f.resource().status.cursor,"scan-cursor");
});

test("expired baselines and missing merge times do not replay historical merges",async t=>{
  const f=fixture(t);f.setPR({...pr(),state:"merged"});await f.observe();assert.equal(f.inputs.list().length,0);
  f.setPR(merged(2));await f.observe(30);assert.equal(f.inputs.list().length,1);
  f.setRead(async()=>scanResult([]));await f.observe(9*86400);
  assert.equal(Object.keys(f.resource().status.tracked!).length,0);
  f.setRead(async()=>scanResult([merged(2)]));await f.observe(9*86400+30);assert.equal(f.inputs.list().length,1);
});

test("configured accounts stay explicit and unique",()=>{
  const watch=ForgeWatchSchema.parse({id:"mine",forge:"gitlab.test",author:"me"});
  assert.equal(watch.intervalMs,300_000);assert.throws(()=>ForgeWatchSchema.parse({...watch,author:"me is:merged"}));
  assert.throws(()=>forgeWatches([watch],[]),/unknown connector/);
  assert.throws(()=>forgeWatches([watch,{...watch,id:"duplicate"}],[{forge:watch.forge}]),/Duplicate/);
});

test("real Runner discovers across IPC and routes a merged Input to Chief; disabled Source stays idle", { timeout: 20_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "aide-forge-runner-"));
  let current = pr(); let discoveries = 0; const prompts: string[] = [];
  const connectors = new Connectors([], createForgeConnectors({ forges: { "gitlab.test": { type: "gitlab", token: "fixture" }, "unavailable.test": { type: "gitlab", token: "fixture" } } }, {
    environment: {}, fetch: async input => {
      const url = new URL(String(input));
      if (url.hostname === "unavailable.test") return new Response("Unavailable", {status: 503});
      const mr = { iid: current.number, title: current.title, web_url: current.url, state: current.state === "open" ? "opened" : current.state,
        sha: current.headSha, author: { username: "me" } };
      if (url.pathname === "/api/v4/merge_requests") { discoveries++; return Response.json([mr]); }
      if (url.pathname.endsWith("/discussions")) return Response.json([]);
      return Response.json(mr);
    },
  }));
  const config = ConfigSchema.parse({ connectors: { forges: { "gitlab.test": { type: "gitlab" }, "unavailable.test": { type: "gitlab" } } },
    plugins: { personal: { weave: { enabled: false }, sources: { forges: [{ id: "mine", forge: "gitlab.test", author: "me" }, {id: "unavailable", forge: "unavailable.test", author: "me"}] } } } });
  const agent = { notify: false, async chief(prompt: string) { prompts.push(prompt); return "Recorded"; }, async execute(): Promise<never> { throw new Error("No work was delegated"); } };
  let aide = new Aide(root, { ...fakeOptions(agent, root), connectors, config }, pino({ level: "silent" }));
  t.after(async () => { await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const inputs = new InputStore(root);
  const until = async (condition: () => boolean) => { const deadline = Date.now() + 10_000; while (!condition()) {
    if (Date.now() > deadline) throw new Error("Forge Source/Chief did not settle");
    await new Promise(r => setTimeout(r, 20));
  } };
  const sourceStore = new PluginResourceStore({ home: root, pluginInstanceId: "personal" });
  await aide.start(); await until(() => Object.keys(sourceStore.list<ForgeWatch, ForgeSourceStatus>(FORGE_SOURCE_TYPE).find(source => source.spec.id === "mine")?.status.tracked ?? {}).length === 1);
  assert.equal(inputs.list().length, 0);
  current = { ...current, state: "merged", headSha: "b" };
  const store = new PluginResourceStore({ home: root, pluginInstanceId: "personal" });
  const source = store.list<ForgeWatch, ForgeSourceStatus>(FORGE_SOURCE_TYPE).find(source => source.spec.id === "mine")!;
  await aide.runtime.enqueue("personal", FORGE_SOURCE_TYPE, source.metadata.name);
  await until(() => inputs.list().filter(i => Object.values(i.status.assess ?? {}).some(a => a.completedAt)).length === 1);
  assert(sourceStore.list<ForgeWatch, ForgeSourceStatus>(FORGE_SOURCE_TYPE).find(source => source.spec.id === "unavailable")?.status.issues?.length);
  assert.ok(prompts.some(p => p.includes("merged"))); assert.equal(aide.topics.list().filter(c => !c.default).length, 1);
  assert.equal(aide.personal.store.read().works.length, 0);
  await aide.close(); const before = discoveries;
  aide = new Aide(root, { ...fakeOptions(agent, root), connectors, config: ConfigSchema.parse({ connectors: config.connectors }) }, pino({ level: "silent" }));
  await aide.start(); await aide.settled(); assert.equal(discoveries, before);
});


test("a frozen batch retains its acceptance horizon across a long interruption",async t=>{
  const f=fixture(t);f.setRead(async()=>scanResult([merged(1),merged(2)]));
  const interrupted:typeof f.resources={...f.resources,async patchStatus(resource,patch){
    if("batch" in patch && (patch.batch as {offset:number}|null)?.offset===1)throw new Error("between items");
    return f.resources.patchStatus(resource,patch);
  }};
  await assert.rejects(observeForge({logger,resources:interrupted},f.resource(),f.connectors,at(30)),/between items/);
  await f.restart();await f.observe(9*86400);
  assert.equal(f.inputs.list().length,2);assert.equal(f.resource().status.cursor,"scan-cursor");
});


test("legacy mergeability ready never becomes platform merge readiness during migration",async t=>{
  const f=fixture(t),key=JSON.stringify(["gitlab.test","org/repo",1]);
  const {conflictState:_conflict,mergeReadiness:_readiness,...facts}=pr();
  await f.resources.patchStatus(f.resource(),{sequence:7,tracked:{[key]:{snapshot:{...facts,mergeability:"ready"},fingerprint:"old"}}} as unknown as Partial<ForgeSourceStatus>);
  f.setPR({...pr(),conflictState:"none",mergeReadiness:"unknown"});await f.observe();
  assert.equal(f.inputs.list().length,0);assert.equal(f.resource().status.tracked![key]!.snapshot.mergeReadiness,"unknown");assert.equal(f.resource().status.sequence,7);
});
