import { textOf, type EventEnvelope } from "../event/index.ts";
import type { MessageState, HarnessState } from "../harness/state.ts";
import { getMessage } from "../message/query.ts";
import { inputMessage } from "../message/project.ts";

/** @spec Reply references preserve unknown versus empty, are unique, and never infer consumption or reorder history. */
export function applyMessageReplies(
  state: HarnessState,
  message: MessageState,
  ids: readonly string[] | undefined,
): void {
  if (ids === undefined) return;
  const unique = [...new Set(ids)];
  // A partial relation would falsely claim completeness. Keep the previous/unknown
  // relation if an adapter references a foreign, missing, or self message.
  if (unique.some((id) => id === message.messageId || !getMessage(state, id))) return;
  message.replyToMessageIds = unique;
}

export function placeMessage(state: HarnessState, id: string, beforeMessageId?: string): void {
  if (state.timeline.some((item) => item.type === "message" && item.id === id)) return;
  const anchor = beforeMessageId === undefined ? -1 : state.timeline.findIndex(
    (item) => item.type === "message" && item.id === beforeMessageId,
  );
  state.timeline.splice(anchor < 0 ? state.timeline.length : anchor, 0, { type: "message", id });
}

/**
 * @spec An unapplied steer has no transcript slot. Its first applied receipt assigns
 * actual execution ownership and position, even before the body or after Turn finalization.
 * Duplicate receipts cannot move it again or turn an applied input into a failed one.
 */
export function applyInputDelivery(state: HarnessState, ev: EventEnvelope<"input_delivery_update">): void {
  const { messageId, state: outcome, beforeMessageId } = ev.payload;
  const known = getMessage(state, messageId);
  if (known && known.kind !== "input") return;
  const input = state.harnessInputs.get(messageId);
  let message = known?.kind === "input" ? known : undefined;
  if (input?.deliveryOutcome === "applied" || message?.consumedAt !== undefined) return;
  if (input) {
    input.deliveryOutcome = outcome;
    if (outcome === "failed") input.status = "failed";
  }
  if (outcome === "applied") {
    if (!message) {
      message = { ...inputMessage(messageId, ev.ts, input?.source, ev.harnessTargetId), content: input ? [...input.blocks] : [], delivery: input?.delivery ?? "steer" };
      state.messages.set(messageId, message);
    }
    message.invocationId = ev.invocationId;
    message.harness = ev.harness;
    message.harnessTargetId = ev.harnessTargetId;
    message.contextId = ev.contextId;
    message.consumedAt = ev.seq;
    // Older ledgers may already have a hidden admission-time slot. Remove that
    // slot only on this first consumption, never on a duplicate receipt.
    const previous = state.timeline.findIndex((item) => item.type === "message" && item.id === messageId);
    if (previous >= 0 && (message.delivery === "steer" || message.delivery === "followUp")) state.timeline.splice(previous, 1);
    placeMessage(state, messageId, beforeMessageId);
  }
  if (message) message.deliveryState = outcome;
  if (outcome === "applied") refreshConsumedSummary(state, message?.invocationId, ev.seq);
}

/** Shared by summary creation and late-consumption replay; pending inputs never enter Context. */
export function invocationUserText(state: HarnessState, invocationId: string): string {
  const parts: string[] = [];
  for (const item of state.timeline) {
    if (item.type !== "message") continue;
    const message = state.messages.get(item.id);
    if (!message || message.role !== "user" || message.invocationId !== invocationId) continue;
    if (message.delivery === "steer" || message.delivery === "followUp") {
      const input = state.harnessInputs.get(message.messageId);
      if (input ? input.deliveryOutcome !== "applied" : message.deliveryState !== undefined && message.deliveryState !== "applied") continue;
    }
    const text = textOf(message.content);
    if (text) parts.push(text);
  }
  return parts.join("\n").replace(/<aide-(context|sync)>[\s\S]*?<\/aide-\1>\s*/g, "").trim();
}

export function refreshConsumedSummary(state: HarnessState, invocationId: string | undefined, seq: number): void {
  if (!invocationId) return;
  const summary = state.invocationSummaries.find((candidate) => candidate.invocationId === invocationId);
  if (!summary) return;
  const userText = invocationUserText(state, invocationId) || undefined;
  if (summary.userText === userText) return;
  // Keep the historical summary Event immutable. The read model includes later
  // facts and advances its Context cursor so an already-synced reader sees them.
  summary.userText = userText;
  summary.updatedSeq = seq;
}
