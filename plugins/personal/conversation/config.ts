import { z } from "zod";
export const ConversationPolicySchema = z.object({
  maxWaitSeconds: z.number().int().min(1).max(86400).default(60),
  batchSize: z.number().int().min(1).max(100).default(10),
  maxPending: z.number().int().min(1).max(1000).default(100),
  contextChars: z.number().int().min(4096).max(200_000).default(48_000),
  summaryChars: z.number().int().min(256).max(16_000).default(4000),
}).strict()
  .refine((p) => p.batchSize <= p.maxPending, { path: ["batchSize"], message: "batchSize must be <= maxPending" })
  .refine((p) => p.summaryChars < p.contextChars / 2, { path: ["summaryChars"], message: "summaryChars must be < contextChars / 2" });
export const conversationPolicy = (config?: unknown) => ConversationPolicySchema.parse(config ?? {});
