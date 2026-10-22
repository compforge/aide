import type { ApprovalContext } from "../harness/adapter.ts";
import { resolutionEvent, requestResult } from "./resolution.ts";
import { createInputRequest } from "../message/project.ts";
import { actorOf } from "../message/actor.ts";
import type { SessionState } from "../store/reduce.ts";
import type { AnyEventDraft, EventSource } from "../event/index.ts";
import type {
  ApprovalDraft,
  ApprovalResult,
} from "./types.ts";

interface HarnessApprovalBinding {
  target: { id: string };
  laneId: string;
}

type AppendEvent<TBinding> = (
  binding: TBinding,
  event: AnyEventDraft,
  source: EventSource,
) => void;

/**
 * Harness 审批请求的进程内 continuation。Core 先持久化 Approval 生命周期，
 * 这里才把终态交还给正在等待的 Adapter。
 */
export class HarnessApprovalContinuations<
  TBinding extends HarnessApprovalBinding,
> {
  private readonly pending = new Map<
    string,
    {
      binding: TBinding;
      turnId?: string;
      resolve: (result: ApprovalResult) => void;
    }
  >();

  constructor(
    private readonly appendEvent: AppendEvent<TBinding>,
    private readonly changed: () => void,
    private readonly projection: () => SessionState,
  ) {}

  open(
    binding: TBinding,
    draft: ApprovalDraft,
    turnId: string | undefined,
    context?: ApprovalContext,
  ): Promise<ApprovalResult> {
    const harnessTargetId = binding.target.id;
    const request = createInputRequest(draft, { kind: "harness", key: harnessTargetId });

    return new Promise((resolve, reject) => {
      this.pending.set(request.messageId, {
        binding,
        turnId,
        resolve,
      });
      try {
        this.appendEvent(
          binding,
          {
            kind: "approval.requested",
            ...(turnId ? { turnId } : {}),
            payload: request,
            ...(context?.raw !== undefined ? { raw: context.raw } : {}),
          },
          { type: "harness", harnessTargetId },
        );
      } catch (error) {
        this.pending.delete(request.messageId);
        reject(error);
        return;
      }
      this.changed();
    });
  }

  turnId(messageId: string): string | undefined {
    return this.pending.get(messageId)?.turnId;
  }

  complete(messageId: string, result: ApprovalResult): boolean {
    const entry = this.pending.get(messageId);
    if (!entry) return false;
    return this.settle(messageId, result, { type: "user" });
  }

  cancelForTurn(turnId: string): void {
    for (const [messageId, entry] of this.pending) {
      if (entry.turnId !== turnId) continue;
      this.settle(
        messageId,
        { kind: "cancelled", reason: "turn" },
        { type: "aide" },
      );
    }
  }

  private settle(
    messageId: string,
    result: ApprovalResult,
    source: EventSource,
  ): boolean {
    const entry = this.pending.get(messageId);
    if (!entry) return false;
    const request = this.projection().approvals.get(messageId)?.request;
    const event = request && resolutionEvent(request, result, actorOf(source));
    if (!event) {
      this.observe();
      return false;
    }
    this.appendEvent(entry.binding, { ...event, ...(entry.turnId ? { turnId: entry.turnId } : {}) }, source);
    const committed = requestResult(this.projection(), messageId);
    this.observe();
    return committed !== undefined;
  }

  /** Session reduction, including external cancellation, is the sole decision owner. */
  observe(): void {
    for (const [messageId, entry] of this.pending) {
      const result = requestResult(this.projection(), messageId);
      if (!result) continue;
      this.pending.delete(messageId);
      entry.resolve(result);
    }
  }
}
