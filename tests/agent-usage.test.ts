import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { usageRoles, UsageIndex } from "../plugins/personal/observation/usage-index.ts";
import { sessionCalls, usageReport } from "../plugins/personal/observation/usage.ts";

test("role usage rebuilds and tails complete entries, including single-call Route sessions", async t => {
  const dir = mkdtempSync(join(tmpdir(), "aide-usage-"));
  t.after(() => rmSync(dir,{ recursive:true,force:true }));
  const now = Date.now(), at = new Date(now-1000).toISOString();
  const entries = (id: string, role: string, cwd = dir) => [
    { type: "session", id, cwd, timestamp: at }, { type: "custom", id: "scope", parentId: null, customType:"aide.agent-scope", data:{scope:role+":uid"} }
  ];
  const msg = (id: string, parentId: string, message: object) => ({ type:"message",id,parentId,timestamp:at,message });
  const call = (input: number) => ({ role:"assistant",model:"m",provider:"p",usage:{input,cacheRead:20,cacheWrite:1,output:2} });
  const lines = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join("\n")+"\n";
  const p = join(dir,"chief.jsonl");
  const original = lines([...entries("c","chief"),
    msg("u","scope",{role:"user",content:"[aide-input:e1]\nstart"}),msg("c1","u",call(10)),
    {type:"custom",id:"mark",parentId:"c1",customType:"aide.usage-origin",data:{origin:"aide:curate"}},
    msg("c2","mark",call(100)), msg("c3","u",{role:"assistant",model:"m",provider:"p"})]);
  writeFileSync(p,original);
  writeFileSync(join(dir,"duplicate.jsonl"),original);
  const result = { role:"toolResult",toolName:"route_input",isError:false,content:[{type:"text",text:'{"routed":"i"}'}] };
  writeFileSync(join(dir,"route.jsonl"),lines([...entries("r","route"),msg("r1","scope",call(1)),msg("done","r1",result),msg("retry","done",result)]));
  writeFileSync(join(dir,"foreign.jsonl"),lines([...entries("other","chief","/another-app"),msg("c","scope",call(99))]));
  const idx = () => new UsageIndex(dir,new Map([[dir,[...usageRoles]]]));
  let index=idx();
  const lookup = (sid: string, marker: string) => { assert.equal(sid,"c"); assert.equal(marker,"e1"); return "aide:followup"; };
  const report = () => usageReport(index,{window:"24h"},lookup,now);
  await Promise.all([index.refresh(now),index.refresh(now)]);
  const first=report(), chief=first.roles.find(r => r.role==="chief")!;
  assert.equal(first.roles.length,6); assert.equal(first.routeInputs,1); assert.equal(first.tokensPerRouteInput,24);
  assert.deepEqual([chief.calls,chief.covered,chief.sessions,chief.input,chief.median,chief.p95],[3,2,1,110,31,121]);
  assert.deepEqual(first.origins.map(r=>[r.origin,r.calls]),[["aide:followup",2],["aide:curate",1]]);
  const detail=sessionCalls(index,"c",{role:"chief",window:"24h"},lookup,1,now)!;
  assert.equal(detail.total,3); assert.equal(detail.items.find(i=>i.id==="c2")?.origin,"aide:curate");
  const suffix=JSON.stringify(msg("c4","mark",call(3)));
  appendFileSync(p,suffix.slice(0,-2)); await index.refresh(now);
  assert.deepEqual(report(),first);
  appendFileSync(p,suffix.slice(-2)+"\n"); await index.refresh(now);
  const updated=report(); assert.equal(updated.roles.find(r=>r.role==="chief")!.calls,4);
  index=idx(); await index.refresh(now); assert.deepEqual(report(),updated);
  assert.equal(sessionCalls(index,"other",{role:"chief",window:"24h"},lookup,1,now),undefined);
});

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
  const usageIndex = new UsageIndex(dir,new Map([[sessions,["route"]]]));
  const log = pino({level:"silent"});
  const obs = new PiObservations(dir,ObservationConfigSchema.parse({}),log);
  const aide = new Aide(dir,{...fakeOptions({ execute: async () => "done" },dir),usageIndex,
    readSession: (agent,role) => obs.read(dir,{ agentDir:dir },agent.sessionId,role) },log);
  const server = httpChannel(aide,log);
  server.listen(0,"127.0.0.1");
  await once(server,"listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    await aide.close();
    rmSync(dir,{ recursive:true,force:true });
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const get = (path: string) => fetch("http://127.0.0.1:"+address.port+path);
  for (const asset of ["/usage","/usage.css","/usage.js"]) assert.equal((await get(asset)).status,200);
  const report = await (await get("/usage/report?window=7d&role=route")).json();
  assert.equal(report.roles.length,6);
  const route = report.roles.find((r: {role: string}) => r.role==="route");
  assert.deepEqual([route.calls,route.total,route.auxiliaryTokens,route.p95],[1,15,5,8]);
  const query = "?role=route&id=session-1";
  assert.equal((await (await get("/usage/calls"+query)).json()).total,2);
  assert.match(await (await get("/usage/session"+query)).text(),/route fixture/);
  assert.equal((await get("/usage/session?id=session-1&role=gate")).status,404);
  assert.equal((await get("/usage/report?window=30d")).status,400);
});
