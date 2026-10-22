import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceStorage } from "../src/host/resource/storage.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import type { InputSpec } from "../plugins/personal/input/model.ts";
import { migratePersonalResources } from "../plugins/personal/migrate.ts";
import { CONVERSATION_TYPE } from "../plugins/personal/conversation/model.ts";

function storage(t: { after(fn: () => void): void }) {
  const home = mkdtempSync(join(tmpdir(), "aide-migration-"));
  const store = new ResourceStorage(home);
  t.after(() => { store.db.close(); rmSync(home, { recursive: true, force: true }); });
  return store;
}
function seed(store: ResourceStorage, key: string, uid: string, scope = JSON.stringify(["legacy", "personal"])) {
  const object = { ...CONVERSATION_TYPE, metadata: { name: "inbox", namespace: "v1", uid,
    sessionId: "legacy", resourceVersion: "7", generation: 3, creationTimestamp: "2026-10-21T00:00:00Z" },
    spec: { id: "inbox", sessionId: "legacy", default: true }, status: { pendingInputIds: ["pending"], contextId: "old-lane",
      reference: { ...CONVERSATION_TYPE, name: "other", namespace: "v1", uid: "other-uid", sessionId: "legacy" } } };
  const data = JSON.stringify({ object, control: { nextReconcileAt: "2026-10-23T00:00:00Z" }, owner: "legacy" });
  store.db.prepare("INSERT INTO resources VALUES (?,?,?,?,?,?,?,?,?)").run(key, scope, "aide.dev/Conversation", uid, data, Buffer.byteLength(data), object.metadata.creationTimestamp, 123, null);
  store.db.prepare("INSERT INTO resource_refs VALUES (?,?)").run(key, "input:pending");
}

test("Personal migration preserves resource identity, default, pending inputs, timer and retention edges", (t) => {
  const store = storage(t);
  seed(store, "legacy-record", "conversation-uid");
  assert.equal(migratePersonalResources(store), 1);
  const row = store.db.prepare("SELECT * FROM resources").get()!;
  const value = JSON.parse(row.data as string);
  assert.equal(row.scope, JSON.stringify([null, "personal"]));
  assert.equal(value.object.metadata.uid, "conversation-uid");
  assert.equal(value.object.metadata.resourceVersion, "7");
  assert.equal(("sessionId" in value.object.metadata ? "unexpected" : undefined), undefined);
  assert.equal(value.object.spec.sessionId, undefined);
  assert.equal(value.object.spec.default, true);
  assert.deepEqual(value.object.status.pendingInputIds, ["pending"]);
  assert.equal(value.object.status.contextId, undefined);
  assert.equal(value.object.status.reference.sessionId, undefined);
  assert.equal(value.control.nextReconcileAt, "2026-10-23T00:00:00Z");
  assert.equal(value.owner, "legacy");
  assert.deepEqual(store.db.prepare("SELECT target FROM resource_refs WHERE source=?").all(row.key!).map((r) => r.target), ["input:pending"]);
  assert.equal(migratePersonalResources(store), 0);
});

test("Conflicting Personal identities roll back the whole migration", (t) => {
  const store = storage(t);
  seed(store, "first", "first-uid");
  seed(store, "second", "second-uid", JSON.stringify(["another", "personal"]));
  assert.throws(() => migratePersonalResources(store), /duplicate Conversation/);
  assert.deepEqual(store.db.prepare("SELECT key FROM resources ORDER BY key").all().map((row) => row.key), ["first", "second"]);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM resource_refs").get()!.n, 2);
});

test("Legacy Core Input moves to Personal without changing topic, evidence or receipts", (t) => {
  const store = storage(t);
  const evidence = { apiVersion: "external.dev/v1", kind: "Input", namespace: "aide-system", name: "external", sessionId: "provider-topic" };
  const fact = { apiVersion: "aide.dev/v1alpha1", kind: "Input", metadata: {
    name: "message:123", namespace: "aide-system", uid: "input:message:123", resourceVersion: "4", generation: 1, creationTimestamp: "2026-10-21T00:00:00Z" },
    spec: { sessionId: "group-topic", origin: "source", originId: "test", text: "original",
      originRef: { ...CONVERSATION_TYPE, namespace: "v1", name: "source", uid: "source-uid", sessionId: "old-source" }, observation: evidence },
    status: { deliveries: ["conversation-uid"], routing: { phase: "done", reason: "delivered" } } };
  const data = JSON.stringify({ object: fact, owner: "old-source" });
  store.db.prepare("INSERT INTO resources VALUES (?,?,?,?,?,?,?,?,?)").run("old-fact", "core", "aide.dev/Input", fact.metadata.uid, data, Buffer.byteLength(data), fact.metadata.creationTimestamp, 1, null);
  store.db.prepare("INSERT INTO receipts VALUES (?,?,?)").run("input:message:123", Date.now() + 60000, JSON.stringify({ at: fact.metadata.creationTimestamp, fingerprint: "legacy" }));
  assert.equal(migratePersonalResources(store), 1);
  const row = store.db.prepare("SELECT scope,data FROM resources").get()!;
  const migrated = JSON.parse(row.data as string).object;
  assert.equal(row.scope, JSON.stringify([null, "personal"]));
  assert.equal(JSON.parse(row.data as string).owner, "group-topic");
  assert.equal(migrated.metadata.uid, fact.metadata.uid);
  assert.equal(migrated.metadata.namespace, "v1");
  assert.equal(migrated.spec.sessionId, "group-topic");
  assert.equal(migrated.spec.originRef.sessionId, undefined);
  assert.deepEqual(migrated.spec.observation, evidence);
  assert.deepEqual(migrated.status, fact.status);
  const inputs = new InputStore(store.home);
  assert.equal(inputs.submit("group-topic", "message:123", migrated.spec as InputSpec).metadata.uid, fact.metadata.uid);
  assert.notEqual(inputs.receipt("message:123")!.fingerprint, "legacy");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM receipts").get()!.n, 1);
});
