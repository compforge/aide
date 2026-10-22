import { Controller, type ControllerOptions } from "../controller/index.ts";
import type { ApprovalResult } from "../approval/types.ts";
import type { SessionHandle } from "../store/store.ts";
import type { SessionState } from "../store/reduce.ts";
import type { ScheduledHarnessInvocation } from "../plugin/harness-invocation.ts";

export type ExecutionOptions = Omit<ControllerOptions, "session">;
const activeJournals = new Set<string>();

/** @spec Harness execution owns its journal lease, native approvals and shutdown; it neither activates plugins nor accepts business inputs.
 * @link docs/kernel.md
 */
export class ExecutionService {
  private readonly controller: Controller;
  private closing?: Promise<void>;
  constructor(private readonly journal: SessionHandle, options: ExecutionOptions) {
    if (activeJournals.has(journal.dir)) throw new Error(`Execution journal is already active: ${journal.dir}`);
    journal.acquireLock();
    activeJournals.add(journal.dir);
    try { this.controller = new Controller({ ...options, session: journal }); }
    catch (error) { activeJournals.delete(journal.dir); journal.releaseLock(); throw error; }
  }
  enqueue(request: ScheduledHarnessInvocation) {
    if (this.closing) throw new Error("Execution service is closing");
    return this.controller.enqueueHarnessInvocation({
      harnessInvocationId: request.invocationId, pluginInstanceId: request.pluginInstanceId,
      harnessTargetId: request.harnessTargetId, laneId: request.laneId, newLane: false,
      freshContext: request.freshContext,
      source: { type: "plugin", pluginInstanceId: request.pluginInstanceId },
      messageId: request.messageId, turnId: request.turnId, blocks: [...request.blocks],
    });
  }
  cancel(invocationId: string) { return this.controller.cancelHarnessInvocation(invocationId); }
  subscribe(listener: () => void) { return this.journal.subscribe(listener); }
  approvals() { return [...this.journal.projection.approvals.values()]; }
  approval(messageId: string) { return this.journal.projection.approvals.get(messageId)?.request; }
  resolveApproval(messageId: string, result: ApprovalResult): boolean {
    if (this.closing) return false;
    return this.controller.completeApproval(messageId, result);
  }
  /** Selected executions only; callers cannot modify the global projection. */
  view(turnIds: readonly string[]): Pick<SessionState, "harnessInputs" | "turnSummaries" | "activeTurns" | "messages" | "toolCalls" | "timeline"> {
    const ids = new Set(turnIds), state = this.journal.projection;
    const inputs = new Map([...state.harnessInputs].filter(([, input]) => ids.has(input.turnId)));
    const messageIds = new Set([...inputs.values()].map(input => input.messageId));
    const messages = new Map([...state.messages].filter(([id, message]) => messageIds.has(id) || (message.turnId && ids.has(message.turnId))));
    const toolCalls = new Map([...state.toolCalls].filter(([, tool]) => tool.turnId && ids.has(tool.turnId)));
    return structuredClone({ harnessInputs: inputs, messages, toolCalls,
      turnSummaries: state.turnSummaries.filter(turn => ids.has(turn.turnId)),
      activeTurns: new Map([...state.activeTurns].filter(([id]) => ids.has(id))),
      timeline: state.timeline.filter(item => messages.has(item.id) || toolCalls.has(item.id)),
    });
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      try { await this.controller.close(); }
      finally {
        try { await this.journal.closeLogs(); }
        finally { activeJournals.delete(this.journal.dir); this.journal.releaseLock(); }
      }
    })();
  }
}
