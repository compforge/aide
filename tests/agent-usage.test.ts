import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { observeEntries } from "../agents/pi/usage.ts";
import { UsageStore } from "../plugins/personal/observation/usage-store.ts";

test("Usage HTTP serves the role dashboard, scoped SessionView and per-call detail", async t => {
  const { mkdirSync } = await import("node:fs");
  const { default: pino } = await import("pino");
  const { Aide } = await import("../src/app.ts");
  const { fakeOptions } = await import("./fake-harness.ts");
  const { httpChannel } = await import("../src/api/index.ts");
  const { PiObservations, ObservationConfigSchema } = await import("../agents/pi/observation.ts");
  const dir = mkdtempSync(join(tmpdir(),"aide-usage-web-")), sessions = join(dir,"sessions");
  mkdirSync(sessions);
  const timestamp = new Date().toISOString();
  const records = [
    {type:"session",version:3,id:"session-1",cwd:dir,timestamp},
    {type:"custom",id:"scope",parentId:null,customType:"aide.agent-scope",data:{scope:"route:uid"},timestamp},
    {type:"message",id:"call",parentId:"scope",timestamp,message:{role:"assistant",provider:"test",model:"route-model",
      content:[{type:"text",text:"route fixture"}],usage:{input:6,output:2,cacheRead:2,cacheWrite:0,totalTokens:10},
      stopReason:"stop",timestamp:Date.now()}},
    {type:"usage",id:"warm",parentId:"call",timestamp,kind:"cache_warm",provider:"test",model:"route-model",
      usage:{input:1,output:0,cacheRead:4,cacheWrite:0}},
  ];
  writeFileSync(join(sessions,"route.jsonl"),records.map(r => JSON.stringify(r)).join("\n")+"\n");
  const dbPath = join(dir,"usage.sqlite");
  const writer = new UsageStore(dbPath);
  const native = observeEntries(SessionManager.open(join(sessions,"route.jsonl")), "route:uid", writer.record.bind(writer));
  const usage = { input:6,output:2,cacheRead:2,cacheWrite:0,totalTokens:10,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0} };
  const id = native.appendMessage({ role:"assistant", provider:"test", api:"openai-completions", model:"route-model",
    content:[{type:"text",text:"route fixture"}], usage, stopReason:"stop", timestamp:Date.now() });
  writer.record("route:uid", native.getSessionId(), native.getEntry(id)!);
  native.appendUsage("cache_warm","test","route-model",{...usage,input:1,output:0,cacheRead:4,totalTokens:5});
  native.appendMessage({role:"toolResult",toolName:"route_input",toolCallId:"route",isError:false,
    content:[{type:"text",text:'{"routed":"input-1"}'}],timestamp:Date.now()});
  writer.close();
  const usageStore = new UsageStore(dbPath);
  const log = pino({level:"silent"});
  const obs = new PiObservations(dir,ObservationConfigSchema.parse({}),log);
  const aide = new Aide(dir,{...fakeOptions({ execute: async () => "done" },dir),usageStore,
    readSession: (agent,role) => obs.read(dir,{ agentDir:dir },agent.sessionId,role) },log);
  const server = httpChannel(aide,log);
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await aide.close();
    usageStore.close();
    rmSync(dir,{ recursive:true,force:true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const get = (path: string) => fetch("http://127.0.0.1:"+address.port+path);
  for (const asset of ["/usage","/usage.css","/usage.js"]) assert.equal((await get(asset)).status,200);
  const report = await (await get("/usage/report?window=7d&role=route")).json();
  assert.equal(report.roles.length,6);
  assert.equal(report.routeInputs, 1);
  const route = report.roles.find((r: {role: string}) => r.role==="route");
  assert.deepEqual([route.calls,route.total,route.auxiliaryTokens,route.p95],[1,15,5,8]);
  const query = "?role=route&id=session-1";
  assert.equal((await (await get("/usage/calls"+query)).json()).total,2);
  assert.match(await (await get("/usage/session"+query)).text(),/route fixture/);
  assert.equal((await get("/usage/session?id=session-1&role=gate")).status,404);
  renameSync(sessions, join(dir,"archived-sessions"));
  assert.deepEqual((await (await get("/usage/report?window=7d&role=route")).json()).roles, report.roles);
  assert.equal((await (await get("/usage/calls"+query)).json()).total,2);
  assert.equal((await get("/usage/report?window=30d")).status,400);
});
