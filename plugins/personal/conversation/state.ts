import type { ResourceClient } from "@compforge/aide-plugin";
import { CONVERSATION_TYPE, type ConversationResource, type ConversationSpec, type ConversationStatus } from "./model.ts";

/** @spec A stale execution cannot mutate a replacement Conversation. */
export async function updateConversation(resources: ResourceClient, ref: Readonly<ConversationResource>,
  change: (current: Readonly<ConversationResource>) => Partial<ConversationStatus>): Promise<Readonly<ConversationResource>> {
  for (let attempt = 0; ; attempt++) {
    const current = await resources.get<ConversationSpec, ConversationStatus>({ ...CONVERSATION_TYPE, ...ref.metadata });
    if (!current || current.metadata.uid !== ref.metadata.uid || current.metadata.deletionTimestamp) throw new Error("Conversation no longer exists");
    const patch = change(current);
    if (!Object.keys(patch).length) return current;
    try { return await resources.patchStatus(current, patch); }
    catch (error) { if (attempt >= 8 || !/version conflict/.test(String(error))) throw error; }
  }
}
