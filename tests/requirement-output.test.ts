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
import { emptyConnectors } from "../src/connector-client.ts";
import { parseAddress, sameAddress } from "../src/address.ts";
import type { RequirementAddress, RequirementComment } from "@compforge/aide-plugin";
import type { OutputSpec } from "../plugins/personal/output/model.ts";
const target: RequirementAddress = { kind: "requirement", source: "work", category: "issue", id: "1", scope: "https://tracker.test/p" };
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), "aide-comment-output-")), store = new OutputStore(root);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  store.subscribe(output => { if (!output.status.delivery) approveFixtureOutput(store, output.metadata.name); });
  store.check = async id => { approveFixtureOutput(store, id); };
  const spec: OutputSpec = { text: "收到", target, topicId: "topic", topic: { apiVersion: "personal.aide.dev/v1", kind: "Topic", namespace: "v1", name: "topic", uid: "topic-uid" } };
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
  const f = fixture(t); f.store.create("s", "output-1", f.spec); let sends = 0;
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
  const f = fixture(t); f.store.create("s", "ambiguous", f.spec); let sends = 0;
  const writer = { requirements: f.requirements, async addRequirementComment() { sends++; throw new Error("network timeout after server accepted"); } };
  await delivery(f.store, writer).reconcile("ambiguous");
  assert.equal(f.store.get("ambiguous")!.status.phase, "uncertain");
  await delivery(new OutputStore(f.root), writer).reconcile("ambiguous"); assert.equal(sends, 1);
  const reader = requirementOutputs({ ...f.requirements, async comments() { return { items: [{ id: "accepted", text: "收到", createdAt: "2026-10-22T00:00:00Z", deliveryId: "ambiguous" }] }; } }, f.store);
  assert.equal((await reader.comments(target)).items[0]!.ownOutput, true);
  assert.equal(f.store.get("ambiguous")!.status.phase, "delivered");
});

test("Interrupted sending and connector reconfiguration never produce another comment", async (t) => {
  const f = fixture(t); f.store.create("s", "interrupted", f.spec); f.store.begin("interrupted"); f.store.create("s", "reconfigured", f.spec);
  let sends = 0;
  const writer = { requirements: { ...f.requirements, async identity() { return { provider: "tracker", scope: "elsewhere" }; } }, async addRequirementComment() { sends++; return { id: "bad", scope: "elsewhere" }; } };
  const worker = delivery(f.store, writer);
  await worker.reconcile("interrupted");
  await assert.rejects(worker.reconcile("reconfigured"), /project changed/);
  assert.equal(sends, 0);
  assert.equal(f.store.get("interrupted")!.status.phase, "uncertain");
  assert.equal(f.store.get("reconfigured")!.status.phase, "pending");
});

test("Preflight failure remains retryable without a send attempt", async (t) => {
  const f = fixture(t); f.store.create("s", "offline", f.spec);
  const writer = { requirements: { ...f.requirements, async identity(): Promise<never> { throw new Error("offline"); } }, async addRequirementComment(): Promise<never> { throw new Error("must not send"); } };
  await assert.rejects(delivery(f.store, writer).reconcile("offline"), /offline/);
  const status = f.store.get("offline")!.status;
  assert.equal(status.phase, "pending"); assert.equal(status.attempts, 0); assert.match(status.lastError!, /preparation failed/);
});
