import { composeMail } from "../plugins/personal/stream/writer.ts";
import { DeliveryError, deliveryFailure } from "@compforge/aide-connector";
import { OutputDelivery } from "../plugins/personal/output/delivery.ts";
import { approveFixtureOutput } from "./output-fixture.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { requirementTransport, requirementOutputs } from "../plugins/personal/output/requirements.ts";
import { emptyConnectors } from "../src/connector/client.ts";
import { parseAddress, sameAddress } from "../src/address.ts";
import type { RequirementAddress, RequirementComment } from "@compforge/aide-plugin";
import type { MailDraft as OutputSpec } from "../plugins/personal/stream/writer.ts";
const target: RequirementAddress = { kind: "requirement", source: "work", category: "issue", id: "1", scope: "https://tracker.test/p" };
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "aide-comment-output-")), store = new OutputStore(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  store.subscribe(output => { if (!output.status.delivery) approveFixtureOutput(store, output.metadata.name); });
  store.check = async id => { approveFixtureOutput(store, id); };
  const spec: OutputSpec = { target, topicId: "topic", topic: { apiVersion: "personal.aide.dev/v1", kind: "Topic", namespace: "v1", name: "topic", uid: "topic-uid" }, content: { kind: "text", text: "收到" } };
  const requirements = { ...emptyConnectors.requirements, async identity() { return { provider: "tracker", scope: target.scope }; } };
  return { root, store, spec, requirements };
}
const log = pino({ level: "silent" });
function delivery(store: OutputStore, writer: Parameters<typeof requirementTransport>[1]) {
  return new OutputDelivery(store, requirementTransport(store, writer), log);
}

test("Requirement addresses pin project scope independently of Person and Topic", () => {
  assert.deepEqual(parseAddress(target), target);
  assert.equal(sameAddress(target, parseAddress({ ...target, scope: "different" })), false);
  assert.throws(() => parseAddress({ kind: "requirement", source: "work", category: "issue", id: "1" }));
});

test("Output delivery persists a comment receipt and filters only its own comment across reclamation", async (t) => {
  const f = fixture(t); composeMail(f.store, "s", "output-1", f.spec); let sends = 0;
  const worker = delivery(f.store, { requirements: f.requirements, async addRequirementComment() { sends++; return { id: "c1", scope: target.scope }; } });
  await worker.reconcile("output-1"); await worker.reconcile("output-1");
  assert.equal(sends, 1); assert.equal(f.store.get("output-1")!.status.phase, "delivered");
  assert.equal(f.store.get("output-1")!.status.receipt?.id, "c1");
  const comments: RequirementComment[] = [{ id: "c1", text: "收到", createdAt: "2026-10-22T00:00:00Z" }, { id: "human", text: "同账号人工回复", createdAt: "2026-10-22T00:00:01Z" }];
  f.store.storage.remove("output:output-1");
  const reader = requirementOutputs({ ...f.requirements, async comments() { return { items: comments }; } }, new OutputStore(f.root));
  const page = await reader.comments(target);
  assert.equal(page.items[0]!.ownOutput, true); assert.equal(page.items[1]!.ownOutput, false);
});

test("Ambiguous send is not retried; correlated observation can recover the receipt", async (t) => {
  const f = fixture(t); composeMail(f.store, "s", "ambiguous", f.spec); let sends = 0;
  const writer = { requirements: f.requirements, async addRequirementComment() { sends++; throw new Error("network timeout after server accepted"); } };
  await delivery(f.store, writer).reconcile("ambiguous");
  assert.equal(f.store.get("ambiguous")!.status.phase, "uncertain");
  await delivery(new OutputStore(f.root), writer).reconcile("ambiguous"); assert.equal(sends, 1);
  const reader = requirementOutputs({ ...f.requirements, async comments() { return { items: [{ id: "accepted", text: "收到", createdAt: "2026-10-22T00:00:00Z", deliveryId: "ambiguous" }] }; } }, f.store);
  assert.equal((await reader.comments(target)).items[0]!.ownOutput, true);
  assert.equal(f.store.get("ambiguous")!.status.phase, "delivered");
});

test("Interrupted sending and connector reconfiguration never produce another comment", async (t) => {
  const f = fixture(t); composeMail(f.store, "s", "interrupted", f.spec); f.store.begin("interrupted"); composeMail(f.store, "s", "reconfigured", f.spec);
  let sends = 0;
  const writer = { requirements: { ...f.requirements, async identity() { return { provider: "tracker", scope: "elsewhere" }; } }, async addRequirementComment() { sends++; return { id: "bad", scope: "elsewhere" }; } };
  const worker = delivery(f.store, writer);
  await worker.reconcile("interrupted");
  await worker.reconcile("reconfigured");
  assert.equal(sends, 0);
  assert.equal(f.store.get("interrupted")!.status.phase, "uncertain");
  assert.equal(f.store.get("reconfigured")!.status.phase, "failed");
  assert.match(f.store.get("reconfigured")!.status.lastError!, /project changed/);
});

test("Preflight failure stops without a send attempt", async (t) => {
  const f = fixture(t); composeMail(f.store, "s", "offline", f.spec);
  const writer = { requirements: { ...f.requirements, async identity(): Promise<never> { throw new Error("offline"); } }, async addRequirementComment(): Promise<never> { throw new Error("must not send"); } };
  await delivery(f.store, writer).reconcile("offline");
  const status = f.store.get("offline")!.status;
  assert.equal(status.phase, "failed"); assert.equal(status.attempts, 0); assert.match(status.lastError!, /preparation failed/);
});


test("Known rejection retries a once-only comment after the adapter deadline, including restart and early wakes", async t => {
  const f = fixture(t); composeMail(f.store, "s", "limited", f.spec); composeMail(f.store, "s", "other", f.spec);
  let now = Date.now(), sends = 0;
  const clock = Date.now; Date.now = () => now; t.after(() => { Date.now = clock; });
  const writer = { requirements: f.requirements, async addRequirementComment() {
    if (++sends === 1) throw new DeliveryError({ kind: "retryable", code: "http:429", message: "Tracker rejected request", retryAfterMs: 30_000 });
    return { id: `c${sends}`, scope: target.scope };
  } };
  const result = await delivery(f.store, writer).reconcile("limited");
  assert.equal(result.requeueAfterMs, 30_000);
  assert.equal(f.store.get("limited")!.status.phase, "pending");
  assert.equal(f.store.get("limited")!.status.attempts, 1);
  assert.match(f.store.get("limited")!.status.lastError!, /http:429/);
  const reopened = new OutputStore(f.root); reopened.check = async id => approveFixtureOutput(reopened, id);
  const restarted = delivery(reopened, writer);
  now += 10_000;
  assert.equal((await restarted.reconcile("limited")).requeueAfterMs, 20_000);
  assert.equal(sends, 1);
  // Another destination has an independent adapter policy and can deliver during this wait.
  await delivery(reopened, { requirements: f.requirements, async addRequirementComment() { return { id: "other", scope: target.scope }; } }).reconcile("other");
  assert.equal(reopened.get("other")!.status.phase, "delivered");
  now += 20_000;
  await restarted.reconcile("limited");
  assert.equal(sends, 2);
  assert.equal(reopened.get("limited")!.status.phase, "delivered");
  assert.equal(reopened.get("limited")!.status.deliveryWait, undefined);
  assert.equal(reopened.get("limited")!.status.lastError, undefined);
});

test("Adapters retain distinct retry delays; absent hints use controller backoff and explicit denial stops", async t => {
  const f = fixture(t);
  for (const [id, delay] of [["quick", 1000], ["slow", 60_000]] as const) {
    composeMail(f.store, "s", id, f.spec);
    const result = await delivery(f.store, { requirements: f.requirements, async addRequirementComment() {
      throw new DeliveryError({ kind: "retryable", message: "Provider cooldown", retryAfterMs: delay });
    } }).reconcile(id);
    assert.ok(result.requeueAfterMs! > delay - 100 && result.requeueAfterMs! <= delay);
  }
  composeMail(f.store, "s", "backoff", f.spec);
  const retry = delivery(f.store, { requirements: f.requirements, async addRequirementComment() {
    throw new DeliveryError({ kind: "retryable", message: "Provider rejected request", code: "busy" });
  } });
  await assert.rejects(retry.reconcile("backoff"), /busy/);
  assert.equal(f.store.get("backoff")!.status.phase, "pending");
  assert.equal(f.store.get("backoff")!.status.deliveryWait, undefined);
  // Even after an earlier rejection, a new preparation failure must replace the saved diagnosis.
  await delivery(f.store, { requirements: { ...f.requirements, async identity() {
    throw new DeliveryError({ kind: "permanent", message: "Account disabled", code: "disabled" });
  } }, async addRequirementComment() { assert.fail("must not send"); } }).reconcile("backoff");
  assert.equal(f.store.get("backoff")!.status.phase, "failed");
  assert.match(f.store.get("backoff")!.status.lastError!, /disabled/);
  composeMail(f.store, "s", "denied", f.spec); let sends = 0;
  const denied = delivery(f.store, { requirements: f.requirements, async addRequirementComment() {
    sends++; throw new DeliveryError({ kind: "permanent", code: "forbidden", message: "Comment permission denied" });
  } });
  await denied.reconcile("denied"); await denied.reconcile("denied");
  assert.equal(sends, 1); assert.equal(f.store.get("denied")!.status.phase, "failed");
  assert.match(f.store.get("denied")!.status.lastError!, /forbidden/);
});

test("Host delivery errors accept another SDK copy while untyped errors and invalid hints remain unknown", () => {
  const failure = { kind: "retryable", code: "429", message: "Rejected", retryAfterMs: 1000 };
  assert.deepEqual(deliveryFailure({ name: "DeliveryError", failure }), failure);
  assert.equal(deliveryFailure(new Error("429")), undefined);
  assert.equal(deliveryFailure({ name: "DeliveryError", failure: { ...failure, kind: { toString: () => "retryable" } } }), undefined);
  for (const retryAfterMs of [-1, NaN, Infinity, "1", 0.1, 2147483648])
    assert.equal(deliveryFailure({ name: "DeliveryError", failure: { ...failure, retryAfterMs } }), undefined);
});


test("Explicit undefined adapter fields preserve retryable and permanent outcomes for once-only writes", async t => {
  const f = fixture(t);
  const optionals = [{}, { code: undefined }, { retryAfterMs: undefined }, { code: undefined, retryAfterMs: undefined }, { code: undefined, retryAfterMs: 0 }];
  for (const kind of ["retryable", "permanent"] as const) for (const [index, optional] of optionals.entries()) {
    const id = `${kind}-${index}`, failure = { kind, message: "Provider rejected comment", ...optional };
    const error = new DeliveryError(failure);
    assert.deepEqual(deliveryFailure(error), { kind, message: failure.message,
      ...(optional.retryAfterMs !== undefined ? { retryAfterMs: optional.retryAfterMs } : {}) });
    composeMail(f.store, "s", id, f.spec);
    const worker = delivery(f.store, { requirements: f.requirements, async addRequirementComment() { throw error; } });
    if (kind === "retryable" && optional.retryAfterMs === undefined) await assert.rejects(worker.reconcile(id), /Provider rejected comment/);
    else await worker.reconcile(id);
    assert.equal(f.store.get(id)!.status.phase, kind === "retryable" ? "pending" : "failed");
    assert.equal(f.store.get(id)!.status.attempts, 1);
    assert.equal(f.store.get(id)!.status.lastError, failure.message);
  }
  for (const invalid of [{ code: null }, { retryAfterMs: null }, { code: 429 }, { retryAfterMs: "1000" }])
    assert.equal(deliveryFailure({ name: "DeliveryError", failure: { kind: "retryable", message: "Rejected", ...invalid } }), undefined);
});
