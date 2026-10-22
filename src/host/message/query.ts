import type { HarnessState } from "../harness/state.ts";
import type { ProjectedMessage } from "../store/message-state.ts";

/** One address space over the existing specialized projections, not another message store. */
export function getMessage(state: HarnessState, messageId: string): ProjectedMessage | undefined {
  return state.messages.get(messageId)
    ?? state.approvals.get(messageId)?.request
    ?? state.inputResponses.get(messageId);
}
