import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "../src/host/event/ledger.ts";
import { ENVELOPE_VERSION } from "../src/host/event/index.ts";
import { HarnessFixtures } from "./harness-fixture.ts";
import { buildTargetCatchUpContext } from "../src/host/context/mention.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readExecutionEvents } from "../src/host/event/legacy.ts";
import { readExecutionContexts } from "../src/host/store/legacy.ts";

const record = (seq: number, kind: string, payload: object, extra: object = {}) => ({
  v: 7, eventId: `event-${seq}`, seq, ts: "2026-10-22T00:00:00.000Z", scope: { type: "application" },
  source: { type: "aide" }, kind, payload, ...extra,
});

test("legacy execution identity conversion preserves ordering, raw data and invocation ownership", () => {
  const raw = { turnId: "provider-native", laneId: "provider-value", input: { turnId: "argument" } };
  const records = [
    record(1, "_aide_harness_invocation_recorded", { invocationId: "call", executionId: "reconcile", laneId: "resource", newLane: false, verb: "harness" }),
    record(2, "_aide_harness_invocation_scheduled", { invocationId: "call", turnId: "old-turn", laneId: "resource", messageId: "prompt" }),
    record(3, "tool_call_update", { toolCallId: "tool", rawInput: raw }, { turnId: "old-turn", laneId: "resource", raw }),
    record(4, "_aide_turn_summary", { turnId: "old-turn", finalText: "finished", toolCalls: [] }, { turnId: "old-turn", laneId: "resource" }),
  ];
  const before = JSON.stringify(records);
  const converted = readExecutionEvents(records);
  assert.equal(JSON.stringify(records), before);
  assert.deepEqual(converted.map(e => [e.eventId, e.seq, e.ts]), records.map(e => [e.eventId, e.seq, e.ts]));
  assert.equal(converted[2]!.invocationId, "call");
  assert.equal(converted[2]!.contextId, "resource");
  assert.deepEqual(converted[2]!.raw, raw);
  assert.deepEqual(converted[2]!.payload, records[2]!.payload);
  assert.equal(converted[3]!.kind, "_aide_invocation_summary");
  assert.equal((converted[3]!.payload as { invocationId: string }).invocationId, "call");
  assert.equal("turnId" in converted[3]!, false);
  assert.equal("laneId" in converted[3]!, false);
  assert.equal("newLane" in converted[0]!.payload, false);
  assert.deepEqual(readExecutionEvents(converted), converted);
});

test("legacy contexts retain native resume state and both history boundaries", () => {
  const native = { harness: "pi", resumeState: { version: 1, data: { sessionFile: "/native/file" } }, contextEpochId: "epoch", syncedSeq: 42, contextAfterSeq: 31 };
  const contexts = readExecutionContexts({ lanes: { resource: { laneId: "resource", createdFor: { type: "session" }, historyAfterSeq: 20, harnessSessions: { target: native } } } });
  assert.deepEqual(contexts.resource, { contextId: "resource", historyAfterSeq: 20, harnessSessions: { target: native } });
  assert.deepEqual(readExecutionContexts({ contexts }), contexts);
  assert.deepEqual(readExecutionContexts({}), {});
});

test("standalone historic execution IDs remain distinct and malformed envelopes fail explicitly", () => {
  const events = readExecutionEvents([record(1, "state_update", { state: "idle" }, { turnId: "historic-one" }), record(2, "state_update", { state: "idle" }, { turnId: "historic-two" })]);
  assert.deepEqual(events.map(e => e.invocationId), ["historic-one", "historic-two"]);
  assert.throws(() => readExecutionEvents([null]), /must be an object/);
  assert.throws(() => readExecutionEvents([{ kind: "state_update", payload: null }]), /requires kind/);
});

// @case Legacy files remain readable without rewriting provider evidence or old bytes.
test("journal reopens v7 records and appends current invocations without a second execution identity", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-legacy-journal-"));
  const path = join(root, "session.jsonl");
  const old = [
    record(1, "_aide_harness_invocation_scheduled", { invocationId: "call", turnId: "old-turn", laneId: "resource", messageId: "prompt" }),
    record(2, "_aide_turn_summary", { turnId: "old-turn", finalText: "finished", toolCalls: [] }, { turnId: "old-turn", laneId: "resource" }),
  ].map(event => JSON.stringify(event)).join("\n") + "\n";
  writeFileSync(path, old);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ledger = new EventLedger({ path });
  assert.equal(ledger.read()[1]!.invocationId, "call");
  ledger.record({ ...record(3, "state_update", { state: "idle", stopReason: "end_turn" }),
    v: ENVELOPE_VERSION, source: { type: "aide" }, scope: { type: "application" },
    kind: "state_update", payload: { state: "idle", stopReason: "end_turn" }, invocationId: "next-call", contextId: "resource" });
  const written = readFileSync(path, "utf8");
  assert.ok(written.startsWith(old));
  const fresh = JSON.parse(written.trimEnd().split("\n").at(-1)!);
  assert.equal(fresh.v, ENVELOPE_VERSION);
  assert.equal("turnId" in fresh, false);
  assert.equal("laneId" in fresh, false);
  assert.deepEqual(new EventLedger({ path }).read().map(event => event.invocationId), [undefined, "call", "next-call"]);
});

// @case Native context restoration never imports another resource or bypasses a reset boundary.
test("catch-up isolates resource and target history, honors cutoffs and keeps the latest budgeted history", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-isolated-history-"));
  const session = new HarnessFixtures(root).create({ cwd: root });
  t.after(async () => { await session.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  session.setExecutionContext("own", { contextId: "own", harnessSessions: {} });
  const summary = (contextId: string, target: string, text: string) => session.appendEvent({
    kind: "_aide_invocation_summary", source: { type: "aide" }, contextId, harnessTargetId: target,
    invocationId: text, payload: { invocationId: text, agentText: text, toolCalls: [] },
  });
  const old = summary("own", "pi", "before-reset");
  session.setExecutionContext("own", { contextId: "own", historyAfterSeq: old.seq, harnessSessions: {} });
  const first = summary("own", "pi", "own-first");
  const latest = summary("own", "pi", "own-latest");
  summary("other", "pi", "other-resource-secret");
  summary("own", "codex", "other-target-secret");
  const options = { target: { id: "pi", harness: "pi" }, contextId: "own", sinceSeq: 0, restoreHistory: true };
  const restored = buildTargetCatchUpContext(session, options)!;
  assert.match(restored.text, /own-first/);
  assert.match(restored.text, /own-latest/);
  assert.doesNotMatch(restored.text, /before-reset|other-resource-secret|other-target-secret/);
  assert.equal(restored.throughSeq, latest.seq);
  assert.equal(buildTargetCatchUpContext(session, { ...options, restoreHistory: false }), null);
  assert.equal(buildTargetCatchUpContext(session, { ...options, sinceSeq: latest.seq }), null);
  assert.doesNotMatch(buildTargetCatchUpContext(session, { ...options, sinceSeq: first.seq })!.text, /own-first/);
  const budgeted = buildTargetCatchUpContext(session, { ...options, budgetChars: 80 })!;
  assert.match(budgeted.text, /own-latest/);
  assert.doesNotMatch(budgeted.text, /own-first/);
  assert.equal(budgeted.throughSeq, latest.seq);
});


test("legacy queue and cancellation facts use the current host coordinates", () => {
  const events = readExecutionEvents([
    record(1, "_aide_queue_reordered", { laneId: "context", orderedMessageIds: ["message"] }),
    record(2, "approval.cancelled", { messageId: "approval", reason: "turn" }),
  ]);
  assert.deepEqual(events[0]!.payload, { contextId: "context", orderedMessageIds: ["message"] });
  assert.deepEqual(events[1]!.payload, { messageId: "approval", reason: "invocation" });
});
