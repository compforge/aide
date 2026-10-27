import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorRegistry } from "../src/host/connector/registry.ts";
import { createConnectorAccess } from "@compforge/aide-connector";

interface Echo { echo(value: { text: string; optional?: string }): Promise<{ text: string; optional?: string }> }
const EchoKind = "test.echo";

test("same-kind connectors are independently discoverable and typed clients are provider-independent", async () => {
  const registry = new ConnectorRegistry();
  const a = registry.register<Echo>(EchoKind, "v1", "work", { metadata: { label: "Work" }, handlers: { async echo(_context, value) { return value; } } }, { revision: "work-v1" });
  registry.register<Echo>(EchoKind, "v1", "personal", { handlers: { async echo(_context, value) { return { text: "personal:" + value.text }; } } });
  registry.register<Echo>("other.echo", "v1", "work", { handlers: { async echo(_context, value) { return value; } } });
  const client = createConnectorAccess(async <T>(request: import("@compforge/aide-connector").ConnectorRequest): Promise<T> => {
    const clone = JSON.parse(JSON.stringify(request));
    return JSON.parse(JSON.stringify(clone.operation === "connector.list" ? await registry.list(clone.kind, clone.version) : await registry.call(clone.connector, clone.method, clone.args))) as T;
  });
  const refs = await client.list("test.echo", "v1"); assert.equal(refs.length, 2);
  assert.equal((await client.list("test.echo", "v2")).length, 0);
  assert.equal((await client.list()).length, 3);
  assert.deepEqual(refs[0]!.methods, ["echo"]);
  assert.deepEqual(await client.get<Echo>(a).echo({ text: "hello", optional: undefined }), { text: "hello" });
  assert.deepEqual(await registry.get<Echo>(refs[1]!).echo({ text: "hello" }), { text: "personal:hello" });
  await registry.close();
});

test("registration rejects duplicate bindings, invalid handlers and non-fact metadata", async () => {
  const registry = new ConnectorRegistry();
  const impl = { handlers: { async echo(_context: unknown, value: {text: string}) { return value; } } };
  registry.register<Echo>(EchoKind, "v1", "one", impl);
  assert.throws(() => registry.register<Echo>(EchoKind, "v1", "one", impl), /already registered/);
  assert.throws(() => registry.register<Echo>(EchoKind, "v1", "missing", { handlers: {} } as never), /Invalid Connector handlers/);
  assert.throws(() => registry.register<Echo>(EchoKind, "v1", "bad", { ...impl, metadata: { value: new Date() } }), /plain data/);
  assert.throws(() => registry.register("bad", "v1", "thenable", { handlers: { async then() {} } }), /Invalid Connector handlers/);
  assert.throws(() => registry.register<Echo>(EchoKind, "v1", "not-callable", { handlers: { echo: 1 } } as never), /Invalid Connector handlers/);
  assert.throws(() => registry.register<Echo>({ kind: EchoKind } as never, "v1", "object-kind", impl), /non-empty string/);
  await registry.close();
});

test("stale references and unsupported methods fail before invoking a replacement", async () => {
  const registry = new ConnectorRegistry(); let calls = 0, closed = 0;
  const ref = registry.register<Echo>(EchoKind, "v1", "work", { handlers: { async echo(_context, value) { calls++; return value; } }, close() { closed++; } }, { revision: "old" });
  await registry.unregister(ref);
  const next = registry.register<Echo>(EchoKind, "v1", "work", { handlers: { async echo(_context, value) { calls++; return value; } } }, { revision: "new" });
  await assert.rejects(registry.get<Echo>(ref).echo({text:"x"}), /stale/);
  await assert.rejects(registry.call(next,"constructor",[]), /not registered/);
  assert.equal(calls,0); assert.equal(closed,1);
  await registry.close(); await assert.rejects(registry.list(), /closed/);
});

test("call capacity is shared across callers, queues are bounded and cancellation releases pending work", async () => {
  const registry = new ConnectorRegistry();
  let release!: () => void, started!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => started = resolve), held = new Promise<void>(resolve => release = resolve);
  const ref = registry.register<Echo>(EchoKind, "v1","shared",{handlers:{async echo(_context,value){calls++;started();await held;return value;}}},{maxConcurrentCalls:1,maxQueuedCalls:1});
  const first = registry.get<Echo>(ref).echo({text:"first"}); await ready;
  const abort = new AbortController();
  const second = registry.call(ref,"echo",[{text:"second"}],{signal:abort.signal});
  await assert.rejects(registry.call(ref,"echo",[{text:"overflow"}]),/queue is full/);
  abort.abort(new Error("cancel queued")); await assert.rejects(second,/cancel queued/);
  release(); assert.deepEqual(await first,{text:"first"}); assert.equal(calls,1);
  await registry.close();
});

test("deadline and close reach implementation signals and do not replay operations", async () => {
  const registry = new ConnectorRegistry(); let calls = 0;
  const ref = registry.register<Echo>(EchoKind, "v1","wait",{handlers:{async echo(context,value){
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
  const ref=registry.register<Echo>(EchoKind, "v1","queued",{handlers:{async echo(_call,value){calls++;started();await held;return value;}}},{maxConcurrentCalls:1});
  const first=registry.get<Echo>(ref).echo({text:"first"});await ready;
  await assert.rejects(registry.withCallOptions({timeoutMs:20},()=>registry.get<Echo>(ref).echo({text:"expired"})),/timed out/);
  release();await first;await new Promise(resolve=>setTimeout(resolve,1));assert.equal(calls,1);await registry.close();
});

test("a typed client pins its reference and a changed revision rejects old calls",async()=>{
  const registry=new ConnectorRegistry();
  const ref=registry.register<Echo>(EchoKind, "v1","pinned",{handlers:{async echo(_context,value){return value;}}},{revision:"access"});
  const client=registry.get<Echo>(ref);
  (ref as {name:string}).name="mutated";
  assert.deepEqual(await client.echo({text:"original"}),{text:"original"});
  const current=(await registry.list(EchoKind))[0]!;await registry.unregister(current);
  registry.register<Echo>(EchoKind, "v1","pinned",{handlers:{async echo(_context,value){return value;}}},{revision:"replacement"});
  await assert.rejects(client.echo({text:"old"}),/stale/);await registry.close();
});

test("connector versions are strings and old-version references cannot call a replacement", async () => {
  const registry = new ConnectorRegistry();
  const implementation = { handlers: { async echo(_context: unknown, value: { text: string }) { return value; } } };
  const old = registry.register<Echo>(EchoKind, "v1", "work", implementation, { revision: "same-access" });
  await registry.unregister(old);
  registry.register<Echo>(EchoKind, "v2", "work", implementation, { revision: "same-access" });
  assert.equal((await registry.list(EchoKind, "v1")).length, 0);
  assert.equal((await registry.list(EchoKind, "v2")).length, 1);
  await assert.rejects(registry.get<Echo>(old).echo({ text: "old" }), /stale/);
  await registry.close();
});

test("concurrent close calls await the same cleanup",async()=>{
  const registry=new ConnectorRegistry();let release!:()=>void,closed=0;
  const done=new Promise<void>(resolve=>release=resolve);
  registry.register<Echo>(EchoKind, "v1","close",{handlers:{async echo(_context,value){return value;}},async close(){closed++;await done;}});
  const first=registry.close(),second=registry.close();assert.equal(first,second);assert.equal(closed,1);
  release();await first;await second;
});
