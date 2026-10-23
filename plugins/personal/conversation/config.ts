import { z } from "zod";
export const ConversationPolicySchema = z.object({
  contextChars: z.number().int().min(4096).max(200_000).default(48_000),
  summaryChars: z.number().int().min(256).max(16_000).default(4000),
}).strict();
export const conversationPolicy = (config?: unknown) => ConversationPolicySchema.parse(config ?? {});
