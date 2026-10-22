import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Verb } from "../src/host/plugin/verb.ts";
import { SessionStore } from "../src/host/store/store.ts";
import { ReconcileCapacity } from "../src/reconcile/queue.ts";
import { emptyReconcileSnapshot } from "../src/host/plugin/reconcile-snapshot.ts";
import { emptyConnectors } from "../src/connector-client.ts";

test("Connector Verb persists dispatch and outcome; orphan recovery records uncertainty without replay", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-connector-verb-"));
  const storage = new SessionStore(root);
  const session = storage.createSession({ id: "source:work", cwd: root });
  let calls = 0;
  let release!: () => void;
  const connectors = { ...emptyConnectors, environments: { ...emptyConnectors.environments, list: async () => {
    calls++;
    assert.equal(session.ledger.read().at(-1)!.kind, "connector.started");
    if (calls === 2) throw new Error("provider unavailable");
    if (calls === 3) await new Promise<void>((resolve) => { release = resolve; });
    return [];
  } } };
  const options = { session, connectors, capacity: new ReconcileCapacity(1), snapshot: () => emptyReconcileSnapshot() };
  const verb = new Verb(options);
  t.after(async () => { release?.(); verb.close(); await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  const context = { pluginInstanceId: "personal", namespace: "v1" as const, executionId: "exec-1", conversationId: "conv" };
  await verb.beginRemote(context);
  const invoke = (timeoutMs: number) => verb.invoke(context, { verb: "connector", input: { request: { operation: "environments.list" }, timeoutMs } });
  assert.equal((await invoke(1000)).state, "success");
  assert.equal((await invoke(1000)).state, "failure");
  assert.equal((await invoke(10)).state, "timeout");
  release();
  verb.endRemote(context.executionId);
  const settled = session.ledger.read().filter((event) => event.kind === "connector.settled");
  assert.deepEqual(settled.map((event) => event.payload.outcome), ["success", "failure", "timeout"]);
  session.appendEvent({ kind: "connector.started", source: { type: "plugin", pluginInstanceId: "personal" },
    payload: { callId: "orphan", executionId: "exec-crashed", attributes: { conversationId: "conv" }, request: { operation: "environments.list" } } });
  const reopened = storage.openSession(session.id);
  const restarted = new Verb({ ...options, session: reopened });
  restarted.failOrphans(); restarted.failOrphans(); restarted.close();
  await reopened.closeLogs();
  assert.equal(calls, 3);
  const records = reopened.ledger.read().filter((event) => event.kind === "connector.settled").filter((event) => event.payload.callId === "orphan");
  assert.equal(records.length, 1);
  assert.equal(records[0]!.payload.outcome, "interrupted");
  assert.ok(reopened.ledger.read().every((event) => event.scope.aideSessionId === session.id));
});
