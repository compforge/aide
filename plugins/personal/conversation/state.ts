import { z } from "zod";
import { SUMMARY_CHARS, RECENT_CHARS } from "../context.ts";
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

export const ConversationContextSchema = z.object({ version: z.string(), summary: z.string().max(SUMMARY_CHARS), recent: z.string().min(1).max(RECENT_CHARS).optional() }).strict();
export type ConversationContextUpdate = z.infer<typeof ConversationContextSchema>;

/** @spec Meaningful synthesis updates understanding independently of Input receipts; recent evidence is optional. Stale synthesis must be merged again. */
export async function summarizeConversation(resources: ResourceClient, owner: Readonly<ConversationResource>, executionId: string, raw: unknown, summaryChars: number) {
  const args = ConversationContextSchema.parse(raw);
  if (args.summary.length > summaryChars) throw new Error(`Conversation summary exceeds ${summaryChars} characters; condense and retry`);
  const updated = await updateConversation(resources, owner, current => {
    if (current.status.execution?.id !== executionId) throw new Error("Chief execution is no longer active");
    if (current.metadata.resourceVersion !== args.version) throw new Error("Conversation context changed; read_input and merge again");
    return { summary: args.summary, ...(args.recent ? { recent: [...current.status.recent, { at: new Date().toISOString(), text: args.recent }] } : {}) };
  });
  return { version: updated.metadata.resourceVersion };
}
