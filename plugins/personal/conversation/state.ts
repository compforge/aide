import type { ResourceClient } from "@compforge/aide-plugin";
import { CONVERSATION_TYPE, type ConversationResource, type ConversationSpec, type ConversationStatus } from "./model.ts";
import type { Batch } from "./batch.ts";

/** @spec A stale execution cannot mutate a replacement Conversation or Batch. */
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
export async function updateBatch(resources: ResourceClient, ref: Readonly<ConversationResource>, id: string,
  change: (batch: Batch) => Partial<Batch>, executionId?: string) {
  return updateConversation(resources, ref, (c) => {
    const batch = c.status.batch;
    if (!batch || batch.id !== id || (executionId && batch.executionId !== executionId)) throw new Error("Batch execution was superseded");
    const next = { ...batch, ...change(batch) };
    for (const key of Object.keys(next) as Array<keyof Batch>) if (next[key] === undefined) delete next[key];
    return { batch: next };
  });
}
