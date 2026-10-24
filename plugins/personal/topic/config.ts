import { z } from "zod";
export const TopicPolicySchema = z.object({
  idleMs: z.number().int().min(1000).default(7 * 24 * 3600_000),
  contextChars: z.number().int().min(4096).max(200_000).default(48_000),
  summaryChars: z.number().int().min(256).max(16_000).default(4000),
}).strict();
export const topicPolicy = (config?: unknown) => TopicPolicySchema.parse(config ?? {});
