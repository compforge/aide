import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventLedger } from "../src/host/event/ledger.ts";
import { ENVELOPE_VERSION, type EventEnvelope } from "../src/host/event/index.ts";
import { HarnessFixtures } from "./harness-fixture.ts";
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
    invocationId: "call-1", runtimeId: "resource", payload: { state: "idle", stopReason: "end_turn" },
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
