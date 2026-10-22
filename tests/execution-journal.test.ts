import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "../src/host/event/ledger.ts";
import { ENVELOPE_VERSION, type EventEnvelope } from "../src/host/event/index.ts";
import { HarnessFixtures } from "./harness-fixture.ts";
import { buildTargetCatchUpContext } from "../src/host/context/history.ts";
import assert from "node:assert/strict";
import { test } from "node:test";

/** @case Current-format replay preserves invocation ownership, raw evidence and ordering without conversion. */
test("execution facts reopen unchanged and malformed or unsupported records fail explicitly", (t) => {
  const root = mkdtempSync(join(tmpdir(), "aide-execution-journal-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "events.jsonl"), ledger = new EventLedger({ path });
  const first: EventEnvelope<"state_update"> = {
    v: ENVELOPE_VERSION, eventId: "event-1", seq: 1, ts: "2026-10-22T00:00:00.000Z",
    scope: { type: "application" }, source: { type: "aide" }, kind: "state_update",
    invocationId: "call-1", contextId: "resource", payload: { state: "idle", stopReason: "end_turn" },
    raw: { turnId: "provider-native", laneId: "provider-data" },
  };
  ledger.record(first);
  const before = readFileSync(path, "utf8");
  assert.deepEqual(new EventLedger({ path }).read(), [first]);
  const second = { ...first, seq: 2, eventId: "event-2", invocationId: "call-2" };
  ledger.record(second);
  assert.ok(readFileSync(path, "utf8").startsWith(before));
  assert.deepEqual(new EventLedger({ path }).read(), [first, second]);
  writeFileSync(path, JSON.stringify({ ...first, v: ENVELOPE_VERSION - 1 }) + "\n");
  assert.throws(() => new EventLedger({ path }).read(), /Unsupported execution event version/);
  writeFileSync(path, "null\n");
  assert.throws(() => new EventLedger({ path }).read(), /Invalid execution event/);
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
