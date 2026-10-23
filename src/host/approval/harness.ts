import type { ApprovalContext } from "../harness/adapter.ts";
import { resolutionEvent, requestResult } from "./resolution.ts";
import { createInputRequest } from "../message/project.ts";
import { actorOf } from "../message/actor.ts";
import type { HarnessState } from "../harness/state.ts";
import type { AnyEventDraft, EventSource } from "../event/index.ts";
import type {
  ApprovalDraft,
  ApprovalResult,
} from "./types.ts";

interface HarnessApprovalBinding {
  target: { id: string };
  runtimeId: string;
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
      invocationId?: string;
      resolve: (result: ApprovalResult) => void;
    }
  >();

  constructor(
    private readonly appendEvent: AppendEvent<TBinding>,
    private readonly changed: () => void,
    private readonly projection: () => HarnessState,
  ) {}

  open(
    binding: TBinding,
    draft: ApprovalDraft,
    invocationId: string | undefined,
    context?: ApprovalContext,
  ): Promise<ApprovalResult> {
    const harnessName = binding.target.id;
    const request = createInputRequest(draft, { kind: "harness", key: harnessName });

    return new Promise((resolve, reject) => {
      this.pending.set(request.messageId, {
        binding,
        invocationId: invocationId,
        resolve,
      });
      try {
        this.appendEvent(
          binding,
          {
            kind: "approval.requested",
            ...(invocationId ? { invocationId: invocationId } : {}),
            payload: request,
            ...(context?.raw !== undefined ? { raw: context.raw } : {}),
          },
          { type: "harness", harnessName },
        );
      } catch (error) {
        this.pending.delete(request.messageId);
        reject(error);
        return;
      }
      this.changed();
    });
  }

  invocationId(messageId: string): string | undefined {
    return this.pending.get(messageId)?.invocationId;
  }

  complete(messageId: string, result: ApprovalResult): boolean {
    const entry = this.pending.get(messageId);
    if (!entry) return false;
    return this.settle(messageId, result, { type: "user" });
  }

  cancelForInvocation(invocationId: string): void {
    for (const [messageId, entry] of this.pending) {
      if (entry.invocationId !== invocationId) continue;
      this.settle(
        messageId,
        { kind: "cancelled", reason: "invocation" },
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
    this.appendEvent(entry.binding, { ...event, ...(entry.invocationId ? { invocationId: entry.invocationId } : {}) }, source);
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
