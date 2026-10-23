import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionService } from "../src/host/runtime/execution.ts";
import { HarnessFixtures } from "./harness-fixture.ts";
import type { ApprovalDraft, ApprovalResult } from "../src/host/approval/types.ts";
import type { HarnessEventSink } from "../src/host/harness/adapter.ts";

const permission: ApprovalDraft = { kind: "permission", title: "Run tool?", options: [
  { optionId: "reject", name: "Reject", polarity: "reject", lifetime: "once" },
] };
const cancelled = { kind: "cancelled", reason: "user" } as const;
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "Expected execution state was not reached");
    await Bun.sleep(5);
  }
}
function fixture(t: { after(fn: () => Promise<void>): void }, startup = false) {
  const root = mkdtempSync(join(tmpdir(), "aide-execution-approval-"));
  const journal = new HarnessFixtures(root).create({ id: "aide:execution", cwd: root });
  const adapters: Array<{ turnId?: string; sink: HarnessEventSink; cancels: number; sends: number; decision?: ApprovalResult }> = [];
  const target = { id: "shared", harness: "test" };
  const executions = new ExecutionService(root, { cwd: root, resolveTarget: () => target, maxConcurrency: 2,
    createAdapter(_target, ports) {
      const state = { cancels: 0, sends: 0 } as (typeof adapters)[number];
      adapters.push(state);
      return {
        harness: "test", capabilities: { prompt: {} },
        async open(_options, sink) {
          state.sink = sink;
          if (startup) state.decision = await ports.openApproval({ kind: "hook_trust", harnessName: "test", hooks: [] });
          return { harness: "test", handleId: String(adapters.indexOf(state)) };
        },
        async sendTurn(_ref, input) {
          state.sends++;
          state.turnId = input.invocationId;
          void ports.openApproval(permission, { invocationId: input.invocationId }).then(result => { state.decision = result; });
          return { accepted: true, effective: "new_turn" };
        },
        async cancel() {
          state.cancels++;
          state.sink({ kind: "state_update", invocationId: state.turnId, payload: { state: "idle", stopReason: "cancelled" } });
        },
        async close() {},
      };
    },
  });
  t.after(async () => { await executions.close(); rmSync(root, { recursive: true, force: true }); });
  const enqueue = (id: string, contextId = id) => {
    if (!journal.meta.contexts[contextId]) journal.setExecutionContext(contextId, { contextId, harnessSessions: {} });
    return executions.enqueue({ invocationId: id, pluginInstanceId: "example", harnessTargetId: target.id,
      contextId, source: "plugin", messageId: `message-${id}`, blocks: [{ type: "text", text: id }] });
  };
  const pending = () => executions.approvals().filter(item => item.request.status === "pending").map(item => item.request.messageId);
  return { executions, journal, adapters, enqueue, pending };
}

/** @case Cancelling one approval interrupts only its execution, even when concurrent resources share a Harness target. */
test("approval cancellation isolates concurrent executions and rejects stale replies after context reuse", async (t) => {
  const { executions, adapters, enqueue, pending } = fixture(t);
  enqueue("first");
  await waitFor(() => pending().length === 1);
  const approval = pending()[0]!;
  enqueue("other");
  await waitFor(() => pending().length === 2);
  assert.equal(executions.resolveApproval(approval, cancelled), true);
  await waitFor(() => executions.view(["first"]).invocationSummaries.length === 1);
  assert.equal(executions.view(["first"]).invocationSummaries[0]!.stopReason, "cancelled");
  assert.deepEqual(adapters.map(adapter => adapter.cancels), [1, 0]);
  assert.equal(executions.view(["other"]).activeInvocations.size, 1);
  assert.equal(pending().length, 1);
  enqueue("replacement", "first");
  await waitFor(() => adapters[0]!.sends === 2);
  assert.equal(executions.resolveApproval(approval, cancelled), false);
  assert.deepEqual(adapters.map(adapter => adapter.cancels), [1, 0]);
  assert.equal(executions.view(["replacement"]).activeInvocations.size, 1);
});

test("rejecting permission settles the request without cancelling execution", async (t) => {
  const { executions, adapters, enqueue, pending } = fixture(t);
  enqueue("rejected");
  await waitFor(() => pending().length === 1);
  const answer = { kind: "permission", outcome: "selected", optionId: "reject" } as const;
  assert.equal(executions.resolveApproval(pending()[0]!, answer), true);
  await waitFor(() => adapters[0]!.decision !== undefined);
  assert.deepEqual(adapters[0]!.decision, answer);
  assert.equal(adapters[0]!.cancels, 0);
  assert.equal(executions.view(["rejected"]).activeInvocations.size, 1);
  adapters[0]!.sink({ kind: "state_update", invocationId: "rejected", payload: { state: "idle", stopReason: "end_turn" } });
  assert.equal(executions.view(["rejected"]).invocationSummaries[0]!.stopReason, "end_turn");
});

test("cancelling startup trust prevents dispatch after the adapter opens", async (t) => {
  const { executions, adapters, enqueue, pending } = fixture(t, true);
  enqueue("starting");
  await waitFor(() => pending().length === 1);
  assert.equal(executions.resolveApproval(pending()[0]!, cancelled), true);
  await waitFor(() => adapters[0]!.decision !== undefined);
  await waitFor(() => executions.view(["starting"]).invocationSummaries.length === 1);
  assert.deepEqual(adapters[0]!.decision, cancelled);
  assert.equal(adapters[0]!.sends, 0);
  assert.equal(executions.view(["starting"]).invocationSummaries[0]!.stopReason, "cancelled");
});

// @case Shared targets do not share execution locks; only the owning resource context serializes calls.
test("same-context invocations serialize while other contexts run, and a late terminal cannot finish the next call", async (t) => {
  const { executions, adapters, enqueue, pending } = fixture(t);
  const first = enqueue("one", "shared-context");
  await waitFor(() => pending().length === 1);
  const second = enqueue("two", "shared-context");
  const other = enqueue("three", "independent-context");
  await waitFor(() => adapters.length === 2 && pending().length === 2);
  assert.equal(adapters[0]!.sends, 1);
  assert.equal(executions.view(["two"]).activeInvocations.size, 0);
  adapters[0]!.sink({ kind: "state_update", invocationId: "one", payload: { state: "idle", stopReason: "end_turn" } });
  await first;
  await waitFor(() => adapters[0]!.sends === 2);
  assert.equal(executions.view(["two"]).activeInvocations.size, 1);
  adapters[0]!.sink({ kind: "state_update", invocationId: "one", payload: { state: "idle", stopReason: "end_turn" } });
  assert.equal(executions.view(["one"]).invocationSummaries.length, 1);
  assert.equal(executions.view(["two"]).activeInvocations.size, 1);
  assert.equal(executions.cancel("two"), "running");
  assert.equal(executions.view(["three"]).activeInvocations.size, 1);
  assert.equal(executions.cancel("three"), "running");
  await Promise.all([second, other]);
});

/** @case A failing observer cannot hide approval notifications from another subscriber. */
test("execution subscribers isolate failures and unsubscribe independently", async (t) => {
  const { executions, enqueue, pending } = fixture(t);
  const stopFailing = executions.subscribe(() => { throw new Error("observer failure"); });
  let approvalsSeen = 0;
  const stopObserving = executions.subscribe(() => { approvalsSeen = pending().length; });
  enqueue("observed");
  await waitFor(() => approvalsSeen === 1);
  stopObserving();
  stopFailing();
  executions.resolveApproval(pending()[0]!, cancelled);
  await waitFor(() => pending().length === 0);
  assert.equal(approvalsSeen, 1);
});
