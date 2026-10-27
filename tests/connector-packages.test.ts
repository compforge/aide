import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, cpSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Connectors } from "../connectors/index.ts";
import { ConnectorRegistry } from "../src/host/connector/registry.ts";
import { loadConnectorPackages } from "../src/host/connector/packages.ts";
import { TicketKind } from "./fixtures/connector-contract.ts";

const entry=fileURLToPath(new URL("./fixtures/connector-package.ts",import.meta.url));
const config={packages:[entry],instances:{work:{type:"fixture-one",config:{prefix:"W",tokenEnv:"TEST_TOKEN"}},personal:{type:"fixture-two",config:{prefix:"P",tokenEnv:"TEST_TOKEN"}}}};

test("an installed external package supplies multiple same-kind connectors through the normal Host registry",async()=>{
  const connectors=await Connectors.load(config,{environment:{TEST_TOKEN:"PRIVATE_CREDENTIAL"}});
  const refs=await connectors.list(TicketKind);assert.equal(refs.length,2);
  assert(!JSON.stringify(refs).includes("PRIVATE_CREDENTIAL"));assert(!JSON.stringify(refs).includes("tokenEnv"));
  for(const ref of refs) assert.equal((await connectors.get(TicketKind,ref).read("ISSUE-1")).connector,ref.name);
  await connectors.close();
});

test("environment changes invalidate references while an unchanged access configuration is stable",async()=>{
  const one=await Connectors.load(config,{environment:{TEST_TOKEN:"one"}}),same=await Connectors.load(config,{environment:{TEST_TOKEN:"one"}}),changed=await Connectors.load(config,{environment:{TEST_TOKEN:"two"}});
  const ref=(await one.list(TicketKind))[0]!;
  assert.equal(ref.revision,(await same.list(TicketKind))[0]!.revision);
  assert.notEqual(ref.revision,(await changed.list(TicketKind))[0]!.revision);
  await assert.rejects(changed.get(TicketKind,ref).read("x"),/stale/);
  await one.close();await same.close();await changed.close();
});

test("configuration errors are scoped without exposing values, disabled entries do not instantiate",async()=>{
  await assert.rejects(Connectors.load({...config,instances:{bad:{type:"fixture-one",config:{prefix:"private-sentinel"}}}},{environment:{TEST_TOKEN:"x"}}),error=>error instanceof Error&&error.message.includes("bad")&&!error.message.includes("private-sentinel"));
  await assert.rejects(Connectors.load({...config,instances:{bad:{type:"missing"}}}),/not installed/);
  await assert.rejects(Connectors.load({packages:[entry,entry]}),/configured twice/);
  const connectors=await Connectors.load({...config,instances:{off:{type:"missing",enabled:false}}});
  assert.equal((await connectors.list(TicketKind)).length,0);await connectors.close();
});

test("failed package assembly closes already created bindings",async()=>{
  const registry=new ConnectorRegistry();
  await assert.rejects(loadConnectorPackages(registry,{...config,instances:{good:config.instances.work,bad:{type:"missing"}}},{environment:{TEST_TOKEN:"x"}}),/not installed/);
  assert.equal((await registry.list(TicketKind)).length,0);
  assert((globalThis as typeof globalThis&{ticketConnectorsClosed?:string[]}).ticketConnectorsClosed?.includes("good"));
  await registry.close();
});

test("npm-style package resolution uses the configured base directory",async t=>{
  const root=mkdtempSync(join(tmpdir(),"aide-installed-connector-"));t.after(()=>rmSync(root,{recursive:true,force:true}));
  const directory=join(root,"node_modules","fixture-connectors");mkdirSync(directory,{recursive:true});
  writeFileSync(join(directory,"package.json"),JSON.stringify({name:"fixture-connectors",version:"1.0.0",type:"module",exports:"./connector-package.ts"}));
  for(const file of ["connector-package.ts","connector-contract.ts"])cpSync(fileURLToPath(new URL("./fixtures/"+file,import.meta.url)),join(directory,file));
  const connectors=await Connectors.load({...config,packages:["fixture-connectors"]},{baseDir:root,environment:{TEST_TOKEN:"fixture"}});
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
  const connectors=await Connectors.load(config,{environment:{TEST_TOKEN:"PRIVATE_CREDENTIAL"}});
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
  const config=ConfigSchema.parse({connectors:{packages:[fileURLToPath(new URL("./fixtures/forge-connector-package.ts",import.meta.url))],instances:{work:{type:"fixture-forge"}}},
    plugins:{personal:{weave:{enabled:false},sources:{repositories:[{id:"repos",forge:"forge.external"}],pullRequests:[{id:"mine",repositories:"repos",author:"me"}]}}}});
  const connectors=await Connectors.load(config.connectors,{environment:{EXTERNAL_TOKEN:"HOST_ONLY"}});
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
  const {ForgeKind}=await import("@compforge/aide-connector/builtin");
  const connectors=await Connectors.load({...config,instances:{...config.instances,github:{type:"github",config:{host:"github.example.com",tokenEnv:"TEST_TOKEN"}}}},{environment:{TEST_TOKEN:"fixture"}});
  const [forge]=await connectors.list(ForgeKind);
  assert.equal(forge?.name,"github");assert.equal(forge?.metadata.forge,"github.example.com");
  assert.equal((await connectors.list(TicketKind)).length,2);
  const catalog=await connectors.describe();assert.deepEqual(catalog.forges,[{forge:"github.example.com",provider:"github"}]);
  await connectors.close();
});
