import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReconcileHarnessInvocation } from "../src/host/plugin/harness-invocation.ts";
import { HarnessInvocationStore } from "../src/host/plugin/harness-invocation.ts";
import { MAIN_LANE_ID } from "../src/host/lane.ts";
import { SessionStore } from "../src/host/store/store.ts";

const roots: string[] = [];

function session() {
  const root = mkdtempSync(join(tmpdir(), "aide-harness-invocation-"));
  roots.push(root);
  return new SessionStore(root).createSession({ cwd: "/repo" });
}

function invocation(
  _journalId: string,
  overrides: Partial<ReconcileHarnessInvocation["invocation"]> = {},
  executionId = "pex_1",
): ReconcileHarnessInvocation {
  return {
    scope: {
      pluginInstanceId: "reqloop_default",
      namespace: "v1",
      executionId,
    },
    invocation: {
      verb: "harness",
      title: "Implement requirement",
      prompt: "Implement REQ-1 and run its focused tests.",
      laneId: "main",
      newLane: false,
      harnessTargetId: "codex",
      ...overrides,
    },
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("HarnessInvocationStore", () => {
  test("creates a fresh invocation and resolves the waiting caller on completion", async () => {
    const handle = session();
    const store = new HarnessInvocationStore(handle);
    const draft = invocation(handle.id);
    const pending = store.record(draft);
    const second = store.record(draft);

    expect(second.invocationId).not.toBe(pending.invocationId);
    expect(pending).toMatchObject({
      executionId: "pex_1",
      verb: "harness",
      phase: "queued",
      newLane: false,
      laneId: MAIN_LANE_ID,
    });
    const scheduled = store.scheduled(pending.invocationId)!;
    const result = store.wait(pending.invocationId);
    handle.appendEvent({
      kind: "user_message",
      source: { type: "plugin", pluginInstanceId: scheduled.pluginInstanceId },
      harness: "codex",
      harnessTargetId: scheduled.harnessTargetId,
      laneId: scheduled.laneId,
      turnId: scheduled.turnId,
      payload: {
        messageId: scheduled.messageId,
        content: [...scheduled.blocks],
      },
    });
    handle.appendEvent({
      kind: "_aide_turn_summary",
      source: { type: "aide" },
      harness: "codex",
      harnessTargetId: scheduled.harnessTargetId,
      laneId: scheduled.laneId,
      turnId: scheduled.turnId,
      payload: {
        turnId: scheduled.turnId,
        stopReason: "end_turn",
        agentText: "Implemented.",
        toolCalls: [],
      },
    });
    await expect(result).resolves.toMatchObject({
      phase: "completed",
      result: { agentText: "Implemented." },
    });
    store.close();
  });

  test("dispatches the supplied prompt directly without a human gate", () => {
    const handle = session();
    const store = new HarnessInvocationStore(handle);
    const pending = store.record(invocation(handle.id, { prompt: "Implement the focused fix." }));
    expect(store.scheduled(pending.invocationId)).toMatchObject({ source: "plugin", blocks: [{ type: "text", text: "Implement the focused fix." }] });
    expect(handle.projection.approvals.size).toBe(0);
    store.close();
  });

  test("allocates a side Lane from the requested parent", () => {
    const handle = session();
    const store = new HarnessInvocationStore(handle);
    const pending = store.record(invocation(handle.id, { newLane: true }));
    const scheduled = store.scheduled(pending.invocationId)!;

    expect(scheduled.newLane).toBe(true);
    expect(scheduled.parentLaneId).toBe("main");
    expect(scheduled.laneId).not.toBe(MAIN_LANE_ID);
    store.close();
  });

  test("persists user cancellation, timeout, dispatch failure, and recovery", async () => {
    const handle = session();
    const store = new HarnessInvocationStore(handle);

    const dismissed = store.record(invocation(handle.id, {}, "pex_dismiss"));
    const dismissedResult = store.wait(dismissed.invocationId);
    expect(store.cancel(dismissed.invocationId, "user")).toBe(true);
    await expect(dismissedResult).resolves.toMatchObject({
      phase: "cancelled",
      cancellation: { reason: "user" },
    });

    const timedOut = store.record(invocation(handle.id, {}, "pex_timeout"));
    expect(store.cancel(timedOut.invocationId, "timeout")).toBe(true);
    expect(store.list().find((item) => item.invocationId === timedOut.invocationId))
      .toMatchObject({ cancellation: { reason: "timeout" } });

    const dispatch = store.record(invocation(handle.id, {}, "pex_dispatch"));
    expect(store.fail(dispatch.invocationId, "dispatch", "unavailable"))
      .toBe(true);
    expect(store.list().find((item) => item.invocationId === dispatch.invocationId))
      .toMatchObject({ failure: { reason: "dispatch", detail: "unavailable" } });

    const recovery = store.record(invocation(handle.id, {}, "pex_recovery"));
    expect(store.failExecution("pex_recovery", "runner exited")).toEqual([
      recovery.invocationId,
    ]);
    expect(store.list().find((item) => item.invocationId === recovery.invocationId))
      .toMatchObject({ failure: { reason: "recovery", detail: "runner exited" } });
    store.close();
  });
});

test("Restored application correlations remain opaque metadata across the SDK change", () => {
  const handle = session();
  // This is the old persisted envelope, not a new caller of the public SDK.
  const payload = { ...invocation(handle.id).invocation, invocationId: "legacy", executionId: "old-run",
    conversationId: "topic", inputIds: ["input-one"], customCorrelation: "opaque" };
  handle.appendEvent({ kind: "_aide_harness_invocation_recorded", source: { type: "plugin", pluginInstanceId: "test" }, payload });
  const restored = new HarnessInvocationStore(handle);
  const result = restored.list()[0]!;
  expect(result.attributes).toEqual({ conversationId: "topic", inputIds: ["input-one"], customCorrelation: "opaque" });
  expect("conversationId" in result).toBe(false);
  restored.close();
});
