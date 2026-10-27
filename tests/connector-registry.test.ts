import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorRegistry } from "../src/host/connector/registry.ts";
import { createConnectorAccess, defineConnectorKind } from "@compforge/aide-connector";

interface Echo { echo(value: { text: string; optional?: string }): Promise<{ text: string; optional?: string }> }
const EchoKind = defineConnectorKind<Echo>({ kind: "test.echo", version: 1, methods: ["echo"] });

test("same-kind connectors are independently discoverable and typed clients are provider-independent", async () => {
  const registry = new ConnectorRegistry();
  const a = registry.register(EchoKind, "work", { metadata: { label: "Work" }, handlers: { async echo(_context, value) { return value; } } }, { revision: "work-v1" });
  registry.register(EchoKind, "personal", { handlers: { async echo(_context, value) { return { text: "personal:" + value.text }; } } });
  const client = createConnectorAccess(async <T>(request: import("@compforge/aide-connector").ConnectorRequest): Promise<T> => {
    const clone = JSON.parse(JSON.stringify(request));
    return JSON.parse(JSON.stringify(clone.operation === "connector.list" ? await registry.list() : await registry.call(clone.connector, clone.method, clone.args))) as T;
  });
  const refs = await client.list(EchoKind); assert.equal(refs.length, 2);
  assert.deepEqual(await client.get(EchoKind, a).echo({ text: "hello", optional: undefined }), { text: "hello" });
  assert.deepEqual(await registry.get(EchoKind, refs[1]!).echo({ text: "hello" }), { text: "personal:hello" });
  await registry.close();
});

test("registration rejects conflicts, incomplete methods and non-fact metadata", async () => {
  const registry = new ConnectorRegistry();
  const impl = { handlers: { async echo(_context: unknown, value: {text: string}) { return value; } } };
  registry.register(EchoKind, "one", impl);
  assert.throws(() => registry.register(EchoKind, "one", impl), /already registered/);
  assert.throws(() => registry.register(EchoKind, "missing", { handlers: {} } as never), /missing method/);
  assert.throws(() => registry.register({ ...EchoKind, methods: ["other"] } as never, "conflict", {handlers:{}} as never), /Conflicting/);
  assert.throws(() => registry.register(EchoKind, "bad", { ...impl, metadata: { value: new Date() } }), /plain data/);
  assert.throws(() => defineConnectorKind({kind:"bad",version:1,methods:["then"]}), /Invalid Connector methods/);
  await registry.close();
});

test("stale references and unsupported methods fail before invoking a replacement", async () => {
  const registry = new ConnectorRegistry(); let calls = 0, closed = 0;
  const ref = registry.register(EchoKind, "work", { handlers: { async echo(_context, value) { calls++; return value; } }, close() { closed++; } }, { revision: "old" });
  await registry.unregister(ref);
  const next = registry.register(EchoKind, "work", { handlers: { async echo(_context, value) { calls++; return value; } } }, { revision: "new" });
  await assert.rejects(registry.get(EchoKind, ref).echo({text:"x"}), /stale/);
  await assert.rejects(registry.call(next,"constructor",[]), /not registered/);
  assert.equal(calls,0); assert.equal(closed,1);
  assert.throws(() => registry.get({...EchoKind,version:2},next), /contract mismatch/);
  await registry.close(); await assert.rejects(registry.list(), /closed/);
});

test("call capacity is shared across callers, queues are bounded and cancellation releases pending work", async () => {
  const registry = new ConnectorRegistry();
  let release!: () => void, started!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => started = resolve), held = new Promise<void>(resolve => release = resolve);
  const ref = registry.register(EchoKind,"shared",{handlers:{async echo(_context,value){calls++;started();await held;return value;}}},{maxConcurrentCalls:1,maxQueuedCalls:1});
  const first = registry.get(EchoKind,ref).echo({text:"first"}); await ready;
  const abort = new AbortController();
  const second = registry.call(ref,"echo",[{text:"second"}],{signal:abort.signal});
  await assert.rejects(registry.call(ref,"echo",[{text:"overflow"}]),/queue is full/);
  abort.abort(new Error("cancel queued")); await assert.rejects(second,/cancel queued/);
  release(); assert.deepEqual(await first,{text:"first"}); assert.equal(calls,1);
  await registry.close();
});

test("deadline and close reach implementation signals and do not replay operations", async () => {
  const registry = new ConnectorRegistry(); let calls = 0;
  const ref = registry.register(EchoKind,"wait",{handlers:{async echo(context,value){
    calls++; await new Promise<never>((_,reject)=>context.signal.addEventListener("abort",()=>reject(context.signal.reason),{once:true}));return value;
  }}});
  await assert.rejects(registry.call(ref,"echo",[{text:"deadline"}],{timeoutMs:20}), /timeout|timed out/i);
  const pending=registry.call(ref,"echo",[{text:"close"}]);
  await new Promise(resolve=>setTimeout(resolve,1)); await registry.close();
  await assert.rejects(pending,/closed/); assert.equal(calls,2);
});

test("inherited execution deadlines expire queued calls before implementations can start",async()=>{
  const registry=new ConnectorRegistry();let release!:()=>void,started!:()=>void,calls=0;
  const ready=new Promise<void>(resolve=>started=resolve),held=new Promise<void>(resolve=>release=resolve);
  const ref=registry.register(EchoKind,"queued",{handlers:{async echo(_call,value){calls++;started();await held;return value;}}},{maxConcurrentCalls:1});
  const first=registry.get(EchoKind,ref).echo({text:"first"});await ready;
  await assert.rejects(registry.withCallOptions({timeoutMs:20},()=>registry.get(EchoKind,ref).echo({text:"expired"})),/timed out/);
  release();await first;await new Promise(resolve=>setTimeout(resolve,1));assert.equal(calls,1);await registry.close();
});

test("a typed client pins its reference and a changed contract version rejects old calls",async()=>{
  const registry=new ConnectorRegistry();
  const ref=registry.register(EchoKind,"pinned",{handlers:{async echo(_context,value){return value;}}},{revision:"access"});
  const client=registry.get(EchoKind,ref);
  (ref as {name:string}).name="mutated";
  assert.deepEqual(await client.echo({text:"original"}),{text:"original"});
  const current=(await registry.list(EchoKind))[0]!;await registry.unregister(current);
  registry.register({...EchoKind,version:2},"pinned",{handlers:{async echo(_context,value){return value;}}},{revision:"access"});
  await assert.rejects(client.echo({text:"old"}),/stale/);await registry.close();
});

test("concurrent close calls await the same cleanup",async()=>{
  const registry=new ConnectorRegistry();let release!:()=>void,closed=0;
  const done=new Promise<void>(resolve=>release=resolve);
  registry.register(EchoKind,"close",{handlers:{async echo(_context,value){return value;}},async close(){closed++;await done;}});
  const first=registry.close(),second=registry.close();assert.equal(first,second);assert.equal(closed,1);
  release();await first;await second;
});
