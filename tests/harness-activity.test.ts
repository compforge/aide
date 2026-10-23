import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HarnessActivity, RECENT_INVOCATIONS } from "../src/host/harness/activity.ts";

test("execution activity is bounded, isolated by invocation, and never restored from disk", async t => {
  const root = mkdtempSync(join(tmpdir(), "aide-activity-"));
  const activity = new HarnessActivity(root, root);
  t.after(async () => { await activity.closeLogs(); rmSync(root, { recursive: true, force: true }); });
  for (let n = 0; n < 100; n++) {
    const id = `run-${n}`;
    activity.appendEvent({ kind: "state_update", source: { type: "aide" }, invocationId: id, payload: { state: "running" } });
    activity.appendEvent({ kind: "agent_message", source: { type: "harness", harnessTargetId: "pi" }, invocationId: id,
      payload: { messageId: id, phase: "final", content: [{ type: "text", text: id }] } });
    activity.appendEvent({ kind: "usage_update", source: { type: "harness", harnessTargetId: "pi" }, invocationId: id, payload: { inputTokens: 10, outputTokens: 20 } });
    activity.appendEvent({ kind: "_aide_notice", source: { type: "aide" }, invocationId: id, payload: { level: "info", title: id } });
    activity.appendEvent({ kind: "_aide_error_update", source: { type: "aide" }, invocationId: id, payload: { code: "fixture", message: id, retryable: false, willRetry: false } });
    activity.appendEvent({ kind: "plan_update", source: { type: "aide" }, invocationId: id, payload: { planId: id, entries: [] } });
    assert.equal(activity.summarizeInvocation(id).finalText, id);
    assert.equal(activity.summarizeInvocation(id).usage?.inputTokens, 10);
    activity.appendEvent({ kind: "state_update", source: { type: "aide" }, invocationId: id, payload: { state: "idle", stopReason: "end_turn" } });
    activity.release(id);
  }
  assert.equal(activity.projection.invocationSummaries.length, RECENT_INVOCATIONS);
  assert.equal(activity.projection.messages.size, RECENT_INVOCATIONS);
  assert.equal(activity.projection.notices.length, RECENT_INVOCATIONS);
  assert.equal(activity.projection.errors.size, RECENT_INVOCATIONS);
  assert.equal(activity.projection.plans.size, RECENT_INVOCATIONS);
  assert.equal(activity.projection.timeline.length, 4 * RECENT_INVOCATIONS);
  assert.equal(existsSync(join(root, "events.jsonl")), false);
  assert.equal(existsSync(join(root, "meta.json")), false);
  const reopened = new HarnessActivity(root, root);
  assert.equal(reopened.projection.messages.size, 0);
  assert.deepEqual(reopened.meta.contexts, {});
  await reopened.closeLogs();
});
