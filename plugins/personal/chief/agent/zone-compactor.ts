import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { deliveredMessageId } from "../../../../agents/pi/input.ts";
import type { InputMessage } from "../../messages.ts";

/** @spec A completed standalone curate turns its transcript into history. Fixed context is rebuilt for each
 * request; a queued or delivered followUp keeps the active exchange intact.
 * @link docs/personal/chief.md#上下文与记忆
 * @case tests/pi-agent.test.ts
 */
export const chiefZoneCompactor: ExtensionFactory = pi => {
  let unsubscribe: (() => void) | undefined;
  pi.on("before_agent_start", start => {
    unsubscribe?.();
    unsubscribe = undefined;
    if (start.messageType !== "custom" || start.message.customType !== "aide.input") return;
    const details = start.message.details as Partial<InputMessage["details"]> | undefined;
    if (!details?.deliveryId || !Array.isArray(details.inputs) || details.inputs.length !== 1 || details.inputs[0]?.origin !== "aide:curate") return;

    // Only curate needs Pi to build a settlement preview of the session branch.
    unsubscribe = pi.on("agent_before_settle", event => {
      if (event.outcome !== "completed" || event.continue || event.context.pendingMessages.length) return;
      const messages = event.context.contextMessages;
      const lastInput = messages.findLast(m => m.role === "user" || (m.role === "custom" && m.customType === "aide.input"));
      if (deliveredMessageId(lastInput) !== details.deliveryId) return;
      const answer = messages.findLast(m => m.role === "assistant");
      if (answer?.stopReason !== "stop" || !answer.content.some(p => p.type === "text" && p.text.trim())) return;
      return { entries: [{ type: "compaction", firstKeptEntryId: null, details: { reason: "aide:curate" },
        summary: "Chief completed curation. Use list_inputs and list_notes for this Topic when earlier evidence is needed." }] };
    });
  });
};
