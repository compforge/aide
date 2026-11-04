import { AideError } from "@compforge/aide-common";
import { larkDeliveryError } from "../src/channel/lark/client.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { DeliveryError } from "@compforge/aide-connector";
import { OutputDelivery } from "../plugins/personal/output/delivery.ts";
import { outputPolicy } from "../plugins/personal/output/config.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { composeMail } from "../plugins/personal/stream/writer.ts";
import { webAddress } from "../src/channel/address.ts";
import { approveFixtureOutput } from "./output-fixture.ts";

const log = pino({ level: "silent" });
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "aide-retry-limit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const open = () => {
    const store = new OutputStore(root);
    store.check = async id => approveFixtureOutput(store, id);
    return store;
  };
  const store = open();
  const create = (id: string) => composeMail(store, "owner", id, { target: webAddress("me"), topicId: "topic",
    topic: { apiVersion: "aide.dev/v1alpha5", kind: "Topic", namespace: "v1", name: "topic", uid: "topic" },
    content: { kind: "text", text: "Hello" } });
  return { store, open, create };
}

/** @case Repeated idempotent unknown failures stop across worker reconstruction without blocking another Output. */
test("Output attempt budget persists and unknown exhaustion remains uncertain", async t => {
  const f = fixture(t); f.create("blocked"); f.create("ready"); let sends = 0;
  for (let round = 0; round < 3; round++) {
    const store = f.open();
    const worker = new OutputDelivery(store, () => ({ replay: "idempotent", async send({ id }) {
      if (id === "blocked") { sends++; throw new DeliveryError({ kind: "unknown", code: "test:ambiguous", message: "Unknown outcome", retryAfterMs: 0 }); }
      return { id: "ok", scope: "test" };
    } }), log, outputPolicy({ maxAttempts: 3 }));
    await worker.reconcile("blocked");
    assert.equal(store.get("blocked")!.status.attempts, round + 1);
    if (round === 2) {
      assert.equal(store.get("blocked")!.status.phase, "uncertain");
      assert.match(store.get("blocked")!.status.lastError!, /attempt limit reached.*test:ambiguous/);
      await worker.reconcile("blocked");
      await worker.reconcile("ready");
    }
    await worker.close();
  }
  assert.equal(sends, 3);
  assert.equal(f.store.get("ready")!.status.phase, "delivered");
});

test("Provider deadline and early wakes consume no extra attempt budget", async t => {
  const f = fixture(t); f.create("limited"); let sends = 0, now = Date.now();
  const clock = Date.now; Date.now = () => now; t.after(() => { Date.now = clock; });
  const worker = new OutputDelivery(f.store, () => ({ replay: "once", async send() {
    sends++; throw new DeliveryError({ kind: "retryable", code: "http:429", message: "Rejected", retryAfterMs: 30_000 });
  } }), log, outputPolicy({ maxAttempts: 2 }));
  t.after(() => worker.close());
  await worker.reconcile("limited");
  for (let i = 0; i < 3; i++) await worker.reconcile("limited");
  assert.equal(sends, 1); assert.equal(f.store.get("limited")!.status.attempts, 1);
  now += 30_001;
  await worker.reconcile("limited");
  assert.equal(sends, 2); assert.equal(f.store.get("limited")!.status.phase, "failed");
  assert.equal(f.store.get("limited")!.status.deliveryWait, undefined);
  assert.match(f.store.get("limited")!.status.lastError!, /attempt limit reached.*http:429/);
  await worker.reconcile("limited"); assert.equal(sends, 2);
});

test("Preparation failure stops without claiming a send attempt", async t => {
  const f = fixture(t); f.create("offline"); let preparations = 0;
  const worker = new OutputDelivery(f.store, () => {
    preparations++; throw new Error("Offline");
  }, log, outputPolicy({ maxAttempts: 1 }));
  t.after(() => worker.close());
  await worker.reconcile("offline"); await worker.reconcile("offline");
  const status = f.store.get("offline")!.status;
  assert.equal(preparations, 1); assert.equal(status.phase, "failed");
  assert.equal(status.attempts, 0);
  assert.match(status.lastError!, /preparation failed/);
});

test("Lowering an attempt policy stops an already over-budget Output before another send", async t => {
  const f = fixture(t); f.create("old"); approveFixtureOutput(f.store, "old");
  f.store.update("old", s => ({ ...s, delivery: { ...s.delivery!, replay: "idempotent" } }));
  f.store.begin("old");
  f.store.update("old", s => ({ ...s, attempts: 20, delivery: { ...s.delivery!, operation: { ...s.delivery!.operation!, attempts: 20 } }, lastError: "Unknown previous outcome" }));
  let sends = 0;
  const worker = new OutputDelivery(f.store, () => ({ replay: "idempotent", async send() { sends++; return undefined; } }), log, outputPolicy({ maxAttempts: 2 }));
  t.after(() => worker.close());
  await worker.reconcile("old");
  assert.equal(sends, 0); assert.equal(f.store.get("old")!.status.phase, "uncertain");
});

test("The default Output attempt budget permits five attempts and then stops", async t => {
  const f = fixture(t); f.create("default"); let sends = 0;
  const worker = new OutputDelivery(f.store, () => ({ replay: "idempotent", async send() {
    sends++; throw new DeliveryError({ kind: "retryable", message: "Rejected", retryAfterMs: 0 });
  } }), log);
  t.after(() => worker.close());
  for (let i = 0; i < 8; i++) await worker.reconcile("default");
  assert.equal(sends, 5); assert.equal(f.store.get("default")!.status.attempts, 5);
  assert.equal(f.store.get("default")!.status.phase, "failed");
});


test("One attempt permits the first send and no retries", async t => {
  const f = fixture(t); f.create("once"); let sends = 0;
  const worker = new OutputDelivery(f.store, () => ({ replay: "idempotent", async send() {
    sends++; throw new DeliveryError({ kind: "retryable", code: "rate_limited", message: "Rejected" });
  } }), log, outputPolicy({ maxAttempts: 1 }));
  t.after(() => worker.close());
  await worker.reconcile("once"); await worker.reconcile("once");
  assert.equal(sends, 1); assert.equal(f.store.get("once")!.status.phase, "failed");
});

test("Lark availability rejection stops after one send and retains both error codes", async t => {
  const f = fixture(t); f.create("denied"); let sends = 0;
  const worker = new OutputDelivery(f.store, () => ({ replay: "idempotent", async send() {
    sends++; throw larkDeliveryError({ response: { status: 400, data: { code: 230013 } } });
  } }), log);
  t.after(() => worker.close());
  for (let i = 0; i < 8; i++) await worker.reconcile("denied");
  assert.equal(sends, 1); assert.equal(f.store.get("denied")!.status.phase, "failed");
  assert.match(f.store.get("denied")!.status.lastError!, /permission_denied.*230013/);
});

test("Common errors respect retryable without assuming a non-idempotent effect was rejected", async t => {
  const f = fixture(t);
  for (const replay of ["idempotent", "once"] as const) for (const retryable of [false, true]) {
    const id = `${replay}-${retryable}`; f.create(id); let sends = 0;
    const worker = new OutputDelivery(f.store, () => ({ replay, async send() {
      sends++; throw new AideError({ retryable, code: "connection_lost", biz_code: "remote_timeout", message: "Connection lost" });
    } }), log, outputPolicy({ maxAttempts: 2 }));
    if (retryable && replay === "idempotent") await assert.rejects(worker.reconcile(id), /connection_lost/);
    else await worker.reconcile(id);
    await worker.reconcile(id);
    assert.equal(sends, retryable && replay === "idempotent" ? 2 : 1);
    assert.equal(f.store.get(id)!.status.phase, "uncertain");
    await worker.close();
  }
});

test("Concurrent wakes and exhausted reservations cannot exceed the send budget", async t => {
  const f = fixture(t); f.create("concurrent"); let sends = 0;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const worker = new OutputDelivery(f.store, () => ({ replay: "idempotent", async send() {
    sends++; await hold; return { id: "done", scope: "test" };
  } }), log, outputPolicy({ maxAttempts: 1 }));
  t.after(() => worker.close());
  const first = worker.reconcile("concurrent");
  await Promise.all(Array.from({ length: 5 }, () => worker.reconcile("concurrent")));
  await first;
  assert.equal(f.store.get("concurrent")!.status.attempts, 1);
  assert.equal(f.store.begin("concurrent", 1), false);
  release(); await worker.close();
  assert.equal(sends, 1); assert.equal(f.store.get("concurrent")!.status.phase, "delivered");
});


test("A retryable preparation error inside the stream loop recovers without consuming a send attempt", async t => {
  const f = fixture(t); f.create("prepare"); let checks = 0, sends = 0;
  f.store.check = async id => {
    if (++checks === 3) throw new AideError({ retryable: true, code: "unavailable", message: "Metadata unavailable" });
    approveFixtureOutput(f.store, id);
  };
  const worker = new OutputDelivery(f.store, () => ({ replay: "idempotent", async send() { sends++; return undefined; } }), log);
  t.after(() => worker.close());
  await assert.rejects(worker.reconcile("prepare"), /unavailable/);
  assert.equal(checks, 3); assert.equal(sends, 0);
  assert.equal(f.store.get("prepare")!.status.preparationAttempts, 1);
  await worker.reconcile("prepare");
  assert.equal(sends, 1); assert.equal(f.store.get("prepare")!.status.attempts, 1);
  assert.equal(f.store.get("prepare")!.status.phase, "delivered");
  assert.equal(f.store.get("prepare")!.status.preparationAttempts, undefined);
});


// @case Transient resolution failures remain bounded across restarts and early provider wakes.
test("Preparation API retries honor deadlines and retain their budget across restart", async t => {
  const f = fixture(t); f.create("prepare-limit"); let lookups = 0, now = Date.now();
  const clock = Date.now; Date.now = () => now; t.after(() => { Date.now = clock; });
  for (let round = 0; round < 2; round++) {
    const store = f.open();
    const worker = new OutputDelivery(store, () => {
      lookups++; throw new DeliveryError({ kind: "retryable", code: "http:429", message: "Metadata limited", retryAfterMs: 30000 });
    }, log, outputPolicy({ maxAttempts: 2 }));
    await worker.reconcile("prepare-limit");
    for (let n = 0; n < 3; n++) await worker.reconcile("prepare-limit");
    assert.equal(lookups, round + 1);
    assert.equal(store.get("prepare-limit")!.status.attempts, 0);
    assert.equal(store.get("prepare-limit")!.status.preparationAttempts, round + 1);
    await worker.close(); now += 30001;
  }
  assert.equal(f.store.get("prepare-limit")!.status.phase, "failed");
});


// @case A restart immediately after terminal acknowledgement cannot recreate the send, including once-only transports.
test("Terminal confirmation atomically saves the receipt, cursor and delivered state", async t => {
  const f = fixture(t); f.create("confirmed"); approveFixtureOutput(f.store, "confirmed");
  f.store.update("confirmed", s => ({ ...s, delivery: { ...s.delivery!, replay: "once" } }));
  f.store.begin("confirmed", 1);
  const states: string[] = [];
  const unsubscribe = f.store.subscribe(o => { if (o.metadata.name === "confirmed") states.push(o.status.phase); });
  f.store.confirm("confirmed", { id: "external", scope: "fixture" }); unsubscribe();
  assert.deepEqual(states, ["delivered"]);
  const reopened = f.open(); let sends = 0;
  const worker = new OutputDelivery(reopened, () => ({ replay: "once", async send() { sends++; return undefined; } }), log, outputPolicy({ maxAttempts: 1 }));
  t.after(() => worker.close()); await worker.reconcile("confirmed");
  assert.equal(sends, 0);
  assert.equal(reopened.get("confirmed")!.status.delivery!.operation, undefined);
  assert.equal(reopened.get("confirmed")!.status.delivery!.confirmedSeq, 1);
  assert.deepEqual(reopened.get("confirmed")!.status.receipt, { id: "external", scope: "fixture" });
});

// @case An acknowledged open update is not an interrupted external write when the worker resumes.
test("Recovery after confirmed progress starts the next operation without replaying the old frame", async t => {
  const f = fixture(t);
  const output = composeMail(f.store, "owner", "progress", { target: webAddress("me"), topicId: "topic",
    topic: { apiVersion: "aide.dev/v1alpha5", kind: "Topic", namespace: "v1", name: "topic", uid: "topic" }, content: { kind: "agent" } });
  f.store.streams.append(output.spec.stream, [{ kind: "agent_message", payload: { messageId: "reply", content: [{ type: "text", text: "partial" }] } }]);
  approveFixtureOutput(f.store, "progress");
  f.store.update("progress", s => ({ ...s, delivery: { ...s.delivery!, replay: "once" } }));
  f.store.begin("progress", 1); f.store.confirm("progress");
  f.store.streams.complete(output.spec.stream);
  const store = f.open(); let sends = 0;
  const worker = new OutputDelivery(store, () => ({ replay: "once", streaming: true, async send({ stream }) {
    sends++; assert.equal(stream.status.phase, "completed"); return { id: "final", scope: "fixture" };
  } }), log, outputPolicy({ maxAttempts: 1 }));
  t.after(() => worker.close()); await worker.reconcile("progress");
  assert.equal(sends, 1); assert.equal(store.get("progress")!.status.phase, "delivered");
  assert.equal(store.get("progress")!.status.attempts, 2);
});


// @case A crash after persisting explicit rejection cannot turn a safe once-only retry into an uncertain result.
test("Recovery may retry a once-only operation with a persisted no-effect rejection", async t => {
  const f = fixture(t); f.create("rejected"); approveFixtureOutput(f.store, "rejected");
  f.store.update("rejected", s => ({ ...s, delivery: { ...s.delivery!, replay: "once" } }));
  f.store.begin("rejected", 2);
  f.store.update("rejected", s => ({ ...s, delivery: { ...s.delivery!, operation: { ...s.delivery!.operation!, lastFailureKind: "retryable" } } }));
  const store = f.open(); let sends = 0;
  const worker = new OutputDelivery(store, () => ({ replay: "once", async send() { sends++; return undefined; } }), log, outputPolicy({ maxAttempts: 2 }));
  t.after(() => worker.close()); await worker.reconcile("rejected");
  assert.equal(sends, 1); assert.equal(store.get("rejected")!.status.phase, "delivered");
  assert.equal(store.get("rejected")!.status.attempts, 2);
});
