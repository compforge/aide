import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ReconcileHarnessInvocation } from "../src/host/harness/invocation.ts";
import { HarnessInvocations } from "../src/host/harness/invocation.ts";
import { HarnessFixtures } from "./harness-fixture.ts";

const roots: string[] = [];

function session() {
  const root = mkdtempSync(join(tmpdir(), "aide-harness-invocation-"));
  roots.push(root);
  const journal = new HarnessFixtures(root).create({ cwd: "/repo" });
  journal.setExecutionContext("resource-context", { contextId: "resource-context", harnessSessions: {} });
  return journal;
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
      contextId: "resource-context",
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

describe("HarnessInvocations", () => {
  test("creates a fresh invocation and resolves the waiting caller on completion", async () => {
    const handle = session();
    const store = new HarnessInvocations(handle);
    const draft = invocation(handle.id);
    const pending = store.record(draft);
    const second = store.record(draft);

    expect(second.invocationId).not.toBe(pending.invocationId);
    expect(pending).toMatchObject({
      executionId: "pex_1",
      verb: "harness",
      phase: "queued",
      contextId: "resource-context",
    });
    const scheduled = store.scheduled(pending.invocationId)!;
    const result = store.wait(pending.invocationId);
    handle.appendEvent({
      kind: "user_message",
      source: { type: "plugin", pluginInstanceId: scheduled.pluginInstanceId },
      harness: "codex",
      harnessTargetId: scheduled.harnessTargetId,
      contextId: scheduled.contextId,
      invocationId: scheduled.invocationId,
      payload: {
        messageId: scheduled.messageId,
        content: [...scheduled.blocks],
      },
    });
    handle.appendEvent({
      kind: "_aide_invocation_summary",
      source: { type: "aide" },
      harness: "codex",
      harnessTargetId: scheduled.harnessTargetId,
      contextId: scheduled.contextId,
      invocationId: scheduled.invocationId,
      payload: {
        invocationId: scheduled.invocationId,
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
    const store = new HarnessInvocations(handle);
    const pending = store.record(invocation(handle.id, { prompt: "Implement the focused fix." }));
    expect(store.scheduled(pending.invocationId)).toMatchObject({ source: "plugin", blocks: [{ type: "text", text: "Implement the focused fix." }] });
    expect(handle.projection.approvals.size).toBe(0);
    store.close();
  });

  test("uses the supplied context and the invocation identity for execution", () => {
    const handle = session();
    const store = new HarnessInvocations(handle);
    const pending = store.record(invocation(handle.id));
    const scheduled = store.scheduled(pending.invocationId)!;
    expect(scheduled.contextId).toBe("resource-context");
    expect(scheduled.invocationId).toBe(pending.invocationId);
    expect("newLane" in scheduled).toBe(false);
    store.close();
  });

  test("coordinates live cancellation, timeout, dispatch failure, and runner interruption", async () => {
    const handle = session();
    const store = new HarnessInvocations(handle);

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

test("Application correlations remain opaque and a new runtime does not recover invocations", () => {
  const handle = session();
  const calls = new HarnessInvocations(handle);
  const draft = invocation(handle.id);
  const result = calls.record({ ...draft, scope: { ...draft.scope,
    attributes: { conversationId: "topic", inputIds: ["input-one"], customCorrelation: "opaque" } } });
  expect(result.attributes).toEqual({ conversationId: "topic", inputIds: ["input-one"], customCorrelation: "opaque" });
  expect("conversationId" in result).toBe(false);
  calls.close();
  const next = new HarnessInvocations(handle);
  expect(next.list()).toEqual([]);
  next.close();
});
