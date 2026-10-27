import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Connectors } from "../connectors/index.ts";
import { ConnectorRegistry } from "../src/host/connector/registry.ts";
import { loadConnectorPackages } from "../src/host/connector/packages.ts";
import { TicketKind, type TicketApi } from "./fixtures/connector-contract.ts";

const entry=fileURLToPath(new URL("./fixtures/connector-package.ts",import.meta.url));
const config={work:{kind:TicketKind,version:"v1",config:{prefix:"W",tokenEnv:"TEST_TOKEN"}},personal:{kind:TicketKind,version:"v1",config:{prefix:"P",tokenEnv:"TEST_TOKEN"}}};

test("an installed external package supplies multiple same-kind connectors through the normal Host registry",async()=>{
  const connectors=await Connectors.load(config,{registration:entry,environment:{TEST_TOKEN:"PRIVATE_CREDENTIAL"}});
  const refs=await connectors.list(TicketKind);assert.equal(refs.length,2);
  assert(!JSON.stringify(refs).includes("PRIVATE_CREDENTIAL"));assert(!JSON.stringify(refs).includes("tokenEnv"));
  for(const ref of refs) assert.equal((await connectors.get<TicketApi>(ref).read("ISSUE-1")).connector,ref.name);
  await connectors.close();
});

test("same-kind connections work independently when one call times out", async () => {
  const connectors = await Connectors.load(config, { registration: entry, environment: { TEST_TOKEN: "fixture" } });
  try {
    const refs = await connectors.list("fixture.ticket", "v1");
    const work = refs.find(ref => ref.name === "work")!, personal = refs.find(ref => ref.name === "personal")!;
    await Promise.all([
      assert.rejects(connectors.call(work, "wait", [1000], { timeoutMs: 20 }), /timed out/),
      connectors.get<TicketApi>(personal).read("ISSUE-1").then(result => assert.equal(result.connector, "personal")),
    ]);
    assert.equal((await connectors.get<TicketApi>(personal).read("ISSUE-2")).connector, "personal");
  } finally { await connectors.close(); }
});

test("environment changes invalidate references while an unchanged access configuration is stable",async()=>{
  const one=await Connectors.load(config,{registration:entry,environment:{TEST_TOKEN:"one"}}),same=await Connectors.load(config,{registration:entry,environment:{TEST_TOKEN:"one"}}),changed=await Connectors.load(config,{registration:entry,environment:{TEST_TOKEN:"two"}});
  const ref=(await one.list(TicketKind))[0]!;
  assert.equal(ref.revision,(await same.list(TicketKind))[0]!.revision);
  assert.notEqual(ref.revision,(await changed.list(TicketKind))[0]!.revision);
  await assert.rejects(changed.get<TicketApi>(ref).read("x"),/stale/);
  await one.close();await same.close();await changed.close();
});

test("declarations select registered names and check contracts without exposing private values", async () => {
  await assert.rejects(Connectors.load({bad:{kind:TicketKind,version:"v1",config:{prefix:"private-sentinel"}}},{registration:entry}),error=>error instanceof Error&&error.message.includes("bad")&&!error.message.includes("private-sentinel"));
  await assert.rejects(Connectors.load({missing:{kind:"missing",version:"v1"}}),/not installed/);
  await assert.rejects(Connectors.load({work:{kind:TicketKind,version:"v2"}},{registration:entry}),/contract mismatch: work/);
  await assert.rejects(Connectors.load({work:{kind:"other",version:"v1"}},{registration:entry}),/contract mismatch: work/);
  const connectors=await Connectors.load({off:{kind:"missing",version:"v1",enabled:false}});
  assert.equal((await connectors.list()).length,0);await connectors.close();
});

test("failed assembly closes already created Connectors",async()=>{
  const registry=new ConnectorRegistry();
  await assert.rejects(loadConnectorPackages(registry,{good:config.work,missing:{kind:"missing",version:"v1"}},{registration:entry,environment:{TEST_TOKEN:"x"}}),/not installed/);
  assert.equal((await registry.list(TicketKind)).length,0);
  assert((globalThis as typeof globalThis&{ticketConnectorsClosed?:string[]}).ticketConnectorsClosed?.includes("good"));
  await registry.close();
});

test("malformed external definitions fail with package identity before creating a connection", async t => {
  const root = mkdtempSync(join(tmpdir(), "aide-malformed-definitions-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cases = [
    { name: "missing-kind", kind: "undefined" },
    { name: "null-kind", kind: "null" },
    { name: "object-kind", kind: '{kind:"fixture"}' },
    { name: "numeric-kind", kind: '123' },
    { name: "empty-kind", kind: '""' },
    { name: "blank-kind", kind: '"  "' },
    { name: "missing-version", kind: '"fixture"', version: "undefined" },
    { name: "numeric-version", kind: '"fixture"', version: "1" },
    { name: "empty-version", kind: '"fixture"', version: '""' },
  ].map(item => {
    const path = join(root, item.name + ".mjs");
    writeFileSync(path, `export let created = false;
      export default {id:"package-${item.name}",version:"1.0.0",connectors:{work:{
        kind:${item.kind},version:${item.version ?? '"v1"'},config:{parse(value){return value;}},
        create(){created=true;return {handlers:{async read(){return "ok";}}};}
      }}};`);
    return { ...item, path };
  });
  for (const item of cases) {
    const registry = new ConnectorRegistry();
    try {
      await assert.rejects(loadConnectorPackages(registry, { work: { kind: "fixture", version: "v1" } }, { registration: item.path }), error => {
        assert(error instanceof Error && !(error instanceof TypeError));
        assert.match(error.message, /Invalid Connector (kind|version|definition)/);
        assert(error.message.includes("package-" + item.name));
        return true;
      });
      assert.equal((await import(pathToFileURL(item.path).href)).created, false);
      assert.equal((await registry.list()).length, 0);
    } finally { await registry.close(); }
  }
});

test("malformed implementations close themselves and prior connections without hiding the assembly error", async t => {
  const root = mkdtempSync(join(tmpdir(), "aide-malformed-implementations-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "package.mjs");
  writeFileSync(path, `export const closed=[];
    const definition={kind:"fixture",version:"v1",config:{parse(value){return value;}},
      create(context, config){return {
        handlers:config.mode==="null"?null:config.mode==="array"?[]:config.mode==="missing"?undefined:{async read(){return "ok";}},
        async close(){closed.push({name:context.name,aborted:context.signal.aborted});if(config.failClose)throw new Error("private-close-error");}
      };}
    }; export default {id:"malformed-implementation",version:"1.0.0",connectors:{good:definition,bad:definition}};`);
  const fixture = await import(pathToFileURL(path).href);
  for (const mode of ["null", "array", "missing"]) {
    fixture.closed.length = 0;
    const registry = new ConnectorRegistry();
    try {
      await assert.rejects(loadConnectorPackages(registry, {
        good: { kind:"fixture",version:"v1" }, bad: { kind:"fixture",version:"v1",config: { mode, failClose: true } },
      }, {registration:path}), error => {
        assert(error instanceof Error && !(error instanceof TypeError));
        assert.match(error.message, /Invalid Connector implementation: bad/);
        assert(error.message.includes("fixture/v1 from malformed-implementation@1.0.0"));
        assert(!error.message.includes("private-close-error"));
        return true;
      });
      assert.equal((await registry.list()).length, 0);
      assert.deepEqual(fixture.closed, [{ name: "bad", aborted: true }, { name: "good", aborted: true }]);
    } finally { await registry.close(); }
    assert.equal(fixture.closed.length, 2);
  }
});

test("npm-style package resolution uses the configured base directory",async t=>{
  const root=mkdtempSync(join(tmpdir(),"aide-installed-connector-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const directory=join(root,"node_modules","fixture-connectors");mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,"package.json"),JSON.stringify({name:"fixture-connectors",version:"1.0.0",type:"module",exports:"./connector-package.ts"}));
  for(const file of ["connector-package.ts","connector-contract.ts"])cpSync(fileURLToPath(new URL("./fixtures/"+file,import.meta.url)),join(directory,file));
  const connectors=await Connectors.load(config,{registration:"fixture-connectors",baseDir:root,environment:{TEST_TOKEN:"fixture"}});
  assert.equal((await connectors.list(TicketKind)).length,2);await connectors.close();
});

test("external kinds work in a real Plugin Runner through direct and execution-scoped verb clients",{timeout:15000},async t=>{
  const {PluginInstanceStore}=await import("../src/host/plugin/instance.ts");
  const {Manager}=await import("../src/host/plugin/manager.ts");
  const {PluginSupervisor}=await import("../src/host/plugin/runner/index.ts");
  const {HarnessFixtures}=await import("./harness-fixture.ts");
  const {runProbe}=await import("./fixtures/resource-probe.ts");
  const root=mkdtempSync(join(tmpdir(),"aide-external-connector-runner-"));
  const session=new HarnessFixtures(root).create({id:"runner",cwd:root});
  const instances=new PluginInstanceStore({home:root});
  instances.create({pluginInstanceId:"consumer",pluginId:"tests/connector-plugin",packageVersion:"1.0.0",marketplace:"fixtures"});
  const connectors=await Connectors.load(config,{registration:entry,environment:{TEST_TOKEN:"PRIVATE_CREDENTIAL"}});
  const installed=join(root,"installed");mkdirSync(installed);
  for(const file of ["connector-plugin.ts","connector-contract.ts"])cpSync(fileURLToPath(new URL("./fixtures/"+file,import.meta.url)),join(installed,file));
  const manager=new Manager({instances,connectors,log:entry=>session.log(entry),pluginSupervisor:new PluginSupervisor(),
    async loadPackageEntry(pluginId,version){return {pluginId,version,entryUrl:pathToFileURL(join(installed,"connector-plugin.ts")).href,resourcesUrl:new URL("./fixtures/environment-definitions.ts",import.meta.url).href};},
  });
  t.after(async()=>{await manager.close();await connectors.close();await session.closeLogs();rmSync(root,{recursive:true,force:true});});
  await manager.start();
  const result=await runProbe(manager,"consumer",{apiVersion:"tests.aide.dev/v1alpha1",kind:"EnvironmentCheck"},"inspect") as {direct: Array<{connector:string}>,viaVerb:Array<{connector:string}>,timeout:string};
  assert.deepEqual(result.direct.map(r=>r.connector),["work","personal"]);
  assert.deepEqual(result.viaVerb.map(r=>r.connector),["work","personal"]);assert.match(result.timeout,/timeout/);
  const ledger=readFileSync(join(root,"connectors/calls.jsonl"),"utf8");
  assert(!ledger.includes("PRIVATE_CREDENTIAL"));assert(!ledger.includes('"args":["verb"]'));
  assert(ledger.includes("fixture.ticket"));
});

test("an external Forge implementation feeds the existing repository and PR Sources without core provider branches",{timeout:20000},async t=>{
  const {Aide}=await import("../src/app.ts");const {ConfigSchema}=await import("../src/config.ts");
  const {fakeOptions}=await import("./fake-harness.ts");const {InputStore}=await import("../plugins/personal/input/store.ts");
  const {default:pino}=await import("pino");
  const root=mkdtempSync(join(tmpdir(),"aide-external-forge-"));
  const config=ConfigSchema.parse({connectors:{work:{kind:"forge",version:"v1"},github:{kind:"forge",version:"v1",config:{provider:"github",host:"github.com"}}},
    plugins:{personal:{weave:{enabled:false},sources:{repositories:[{id:"repos",forge:"forge.external"}],pullRequests:[{id:"mine",repositories:"repos",author:"me"}]}}}});
  const connectors=await Connectors.load(config.connectors,{registration:fileURLToPath(new URL("./fixtures/forge-connector-package.ts",import.meta.url)),environment:{EXTERNAL_TOKEN:"HOST_ONLY",GITHUB_TOKEN:"GITHUB_HOST_ONLY"}});
  assert.deepEqual((await connectors.list("forge", "v1")).map(d => d.name), ["work", "github"]);
  const prompts:string[]=[];
  const agent={notify:false,async chief(prompt:string){prompts.push(prompt);return "Recorded";},async execute():Promise<never>{throw new Error("No work");}};
  const aide=new Aide(root,{...fakeOptions(agent,root),config,connectors,connectorCatalog:await connectors.list()},pino({level:"silent"}));
  t.after(async()=>{await aide.close();await connectors.close();rmSync(root,{recursive:true,force:true});});
  const inputs=new InputStore(root);await aide.start();
  const deadline=Date.now()+12000;
  while(!inputs.list().some(i=>Object.values(i.status.assess??{}).some(a=>a.completedAt))){if(Date.now()>deadline)throw new Error("External Forge pipeline did not settle");await new Promise(r=>setTimeout(r,20));}
  assert.equal(inputs.list().length,1);assert.equal(inputs.list()[0]!.spec.observation?.kind,"forge.merged");
  assert(prompts.some(p=>p.includes("External merge")));assert(!JSON.stringify(inputs.list()).includes("HOST_ONLY"));
});

test("built-in Forge providers use the same configured connection path and coexist with external kinds",async()=>{
  const {ForgeKind}=await import("@compforge/aide-connector/forge");
  const connectors=await Connectors.load({...config,github:{kind:"forge",version:"v1",config:{provider:"github",host:"github.example.com",tokenEnv:"TEST_TOKEN"}}},{registration:entry,environment:{TEST_TOKEN:"fixture"}});
  const [forge]=await connectors.list(ForgeKind);
  assert.equal(forge?.name,"github");assert.equal(forge?.metadata.forge,"github.example.com");
  assert.equal((await connectors.list(TicketKind)).length,2);
  const catalog=await connectors.describe();assert.deepEqual(catalog.forges,[{forge:"github.example.com",provider:"github"}]);
  await connectors.close();
});

test("declarations reject implementation selectors and wrappers", async () => {
  const { ConfigSchema } = await import("../src/config.ts");
  for (const connectors of [
    { packages: [entry] }, { instances: { work: { type: "fixture" } } },
    { connections: { work: { kind: TicketKind, version: "v1" } } },
    { work: { kind: TicketKind, version: "v1", type: "fixture" } },
    { work: { kind: TicketKind } },
    { " work ": { kind: TicketKind, version: "v1" } },
  ]) assert.equal(ConfigSchema.safeParse({ connectors }).success, false);
  const declaration = ConfigSchema.parse({ connectors: config });
  assert.deepEqual(Object.keys(declaration.connectors), ["work", "personal"]);
});

test("built-in access revisions change with endpoint, protocol or credentials", async () => {
  const settings = { provider: "gitlab", host: "gitlab.test", forge: "work", token: "private-fixture" };
  const revision = async (config: typeof settings) => {
    const connectors = await Connectors.load({ work: { kind: "forge", version: "v1", config } }, { environment: {} });
    try { return (await connectors.list("forge", "v1"))[0]!.revision; }
    finally { await connectors.close(); }
  };
  const initial = await revision(settings);
  assert.match(initial, /^[a-f0-9]{64}$/);
  assert.equal(await revision({ ...settings }), initial);
  for (const update of [{ token: "other" }, { host: "other.test" }, { provider: "github" }]) {
    assert.notEqual(await revision({ ...settings, ...update }), initial);
  }
  await assert.rejects(Connectors.load({ work: { kind: "forge", version: "v1", config: { provider: "gitlab", host: "gitlab.test" } } }, { environment: {} }), /creation failed: work/);
});

test("all built-in kinds are assembled under their declared names", async () => {
  const connectors = await Connectors.load({
    office: { kind: "environment", version: "v1", config: { laptop: { kind: "host" } } },
    work: { kind: "requirement", version: "v1", config: { provider: "meego", projectKey: "project" } },
    chat: { kind: "messages", version: "v1", config: { appId: "cli_app", userId: "ou_user" } },
  });
  try {
    assert.deepEqual((await connectors.list()).map(d => d.name), ["office", "work", "chat"]);
    assert.deepEqual(await connectors.environments.list(), [{ name: "laptop", kind: "host" }]);
    assert.equal((await connectors.describe()).messages?.accountId, "cli_app");
  } finally { await connectors.close(); }
});
