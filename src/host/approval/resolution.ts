import type { ActorRef, InputRequest, InputResponse } from "../message/types.ts";
import type { EventDraft } from "../event/index.ts";
import { newId } from "../event/ids.ts";
import type { HarnessState } from "../harness/state.ts";
import type { ApprovalResult } from "./types.ts";
import { validInputResult } from "./answer.ts";

/** @spec Only a pending request can accept an authorized, typed resolution. */
export function canResolveRequest(request: InputRequest, result: ApprovalResult, actor: ActorRef): boolean {
  return request.status === "pending"
    && (actor.kind === "user" || actor.kind === "aide")
    && validInputResult(request.request, result);
}

/** Prepare a typed fact; only Session commit may turn it into a decision. */
export function resolutionEvent(request: InputRequest, result: ApprovalResult, actor: ActorRef):
  EventDraft<"approval.answered"> | EventDraft<"approval.cancelled"> | undefined {
  if (!canResolveRequest(request, result, actor)) return undefined;
  if (result.kind === "cancelled") {
    return { kind: "approval.cancelled", payload: {
      messageId: request.messageId, reason: result.reason,
      ...(result.detail === undefined ? {} : { detail: result.detail }),
    } };
  }
  const response: InputResponse = {
    kind: "input_response", messageId: newId("m"), createdAt: new Date().toISOString(),
    source: actor, target: request.source, replyToMessageIds: [request.messageId], answer: result,
  };
  return { kind: "approval.answered", payload: response };
}

/** Continuations read the committed decision; they never reduce terminal facts themselves. */
export function requestResult(state: HarnessState, messageId: string): ApprovalResult | undefined {
  const request = state.approvals.get(messageId)?.request;
  if (request?.status === "cancelled" && request.cancellation) {
    return { kind: "cancelled", ...request.cancellation };
  }
  if (request?.status === "answered" && request.responseMessageId) {
    return state.inputResponses.get(request.responseMessageId)?.answer;
  }
  return undefined;
}
