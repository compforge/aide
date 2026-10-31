import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Verb } from "../src/host/plugin/verb.ts";
import { ConnectorCalls } from "../src/host/connector/calls.ts";
import { EventLedger } from "../src/host/event/ledger.ts";
import { ENVELOPE_VERSION } from "../src/host/event/index.ts";
import { ReconcileCapacity } from "../src/reconcile/queue.ts";
import { emptyReconcileSnapshot } from "../src/host/plugin/reconcile-snapshot.ts";
import { emptyConnectors } from "../src/connector/client.ts";

test("Connector Verb persists dispatch and outcome; orphan recovery records uncertainty without replay", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-connector-verb-"));
  const connectorCalls = new ConnectorCalls(root);
  const ledger = new EventLedger({ path: join(root, "connectors", "calls.jsonl") });
  let calls = 0;
  let release!: () => void;
  const connectors = { ...emptyConnectors, environments: { ...emptyConnectors.environments, list: async () => {
    calls++;
    assert.equal(ledger.read().at(-1)!.kind, "connector.started");
    if (calls === 2) throw new Error("provider unavailable");
    if (calls === 3) await new Promise<void>((resolve) => { release = resolve; });
    return [];
  } } };
  const options = { connectorCalls, connectors, capacity: new ReconcileCapacity(1) };
  const verb = new Verb(options);
  t.after(async () => { release?.(); verb.close(); rmSync(root, { recursive: true, force: true }); });
  const context = { pluginInstanceId: "personal", namespace: "v1" as const, executionId: "exec-1", topicId: "conv" };
  await verb.beginRemote(context);
  const invoke = (timeoutMs: number) => verb.invoke(context, { verb: "connector", input: { request: { operation: "environments.list" }, timeoutMs } });
  assert.equal((await invoke(1000)).state, "success");
  assert.equal((await invoke(1000)).state, "failure");
  assert.equal((await invoke(10)).state, "timeout");
  release();
  verb.endRemote(context.executionId);
  const settled = ledger.read().filter((event) => event.kind === "connector.settled");
  assert.deepEqual(settled.map((event) => event.payload.outcome), ["success", "failure", "timeout"]);
  ledger.record({ v: ENVELOPE_VERSION, seq: 100, eventId: "orphan", ts: new Date().toISOString(), scope: { type: "application" }, kind: "connector.started", source: { type: "plugin", pluginInstanceId: "personal" },
    payload: { callId: "orphan", executionId: "exec-crashed", attributes: { topicId: "conv" }, request: { operation: "environments.list" } } });
  verb.close();
  const restarted = new Verb({ ...options, connectorCalls: new ConnectorCalls(root) });
  restarted.failOrphans(); restarted.failOrphans(); restarted.close();
  assert.equal(calls, 3);
  assert.equal(existsSync(join(root, "harness")), false);
  const records = ledger.read().filter((event) => event.kind === "connector.settled").filter((event) => event.payload.callId === "orphan");
  assert.equal(records.length, 1);
  assert.equal(records[0]!.payload.outcome, "interrupted");
  assert.ok(ledger.read().every((event) => event.scope.type === "application"));
});

/** @case A competing writer cannot change dispatch facts; restart records uncertainty once. */
test("Connector recovery is independent of Harness storage and rejects a competing writer", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-connector-recovery-"));
  const first = new ConnectorCalls(root), competitor = new ConnectorCalls(root);
  let reopened: ConnectorCalls | undefined;
  t.after(() => { first.close(); competitor.close(); reopened?.close(); rmSync(root, { recursive: true, force: true }); });
  const callId = first.start({ pluginInstanceId: "test", executionId: "execution", namespace: "v1" }, { operation: "environments.list" });
  assert.throws(() => competitor.failOrphans(), /already active/);
  first.close();
  reopened = new ConnectorCalls(root); reopened.failOrphans(); reopened.failOrphans(); reopened.close();
  const events = new EventLedger({ path: join(root, "connectors", "calls.jsonl") }).read();
  assert.equal(events.length, 2);
  assert.equal(events[0]!.kind, "connector.started");
  assert.equal(events[1]!.kind, "connector.settled");
  assert.deepEqual(events[1]!.payload, { callId, outcome: "interrupted", error: "Core restarted; external outcome is unknown" });
  assert.equal(existsSync(join(root, "connectors", "lock")), false);
  assert.equal(existsSync(join(root, "harness")), false);
});
