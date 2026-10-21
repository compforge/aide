import { isChannelAddress, webAddress } from "./address.ts";
import type { ChannelService } from "./service.ts";
import type { OutputView } from "../output.ts";

/** Questions remain Core Interaction projections, not persisted Outputs. */
export function channelOutputs(service: Pick<ChannelService, "outputs"> & Partial<Pick<ChannelService, "questions" | "findConversation">>): OutputView[] {
  const questions: OutputView[] = (service.questions?.() ?? []).flatMap(({ conversationId, request }) => {
    const c = service.findConversation?.(conversationId)?.conversations.resource(conversationId);
    if (!c || request.request.kind !== "question") return [];
    const address = c.spec.address;
    return [{ id: request.messageId, conversationId, conversationUid: c.metadata.uid, role: "aide" as const, at: request.createdAt, workId: null,
      target: address ?? webAddress(conversationId),
      status: { phase: "pending" as const, attempts: 0 },
      text: request.request.questions.map((q) => [q.question, ...(q.choices ?? []).map((choice) => `${choice.label} (${choice.value})`)].join("\n")).join("\n") }];
  });
  return [...service.outputs(), ...questions].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
}

/** Web shows the producing Conversation's record and messages explicitly delivered to this endpoint. */
export function visibleOutput(output: OutputView, conversation: { spec: { id: string }; metadata: { uid: string; creationTimestamp: string } }): boolean {
  if (output.conversationId === conversation.spec.id) return output.conversationUid === conversation.metadata.uid;
  // A new destination Conversation does not inherit messages delivered before its creation.
  return isChannelAddress(output.target) && output.target.channelId === "web" && output.target.endpoint === conversation.spec.id
    && output.at >= conversation.metadata.creationTimestamp;
}
