import { z } from "zod";
export const WeavePolicySchema = z.object({
  enabled: z.boolean().default(true),
  intervalMs: z.number().int().min(1000).default(300_000),
  rootThreshold: z.number().int().min(2).default(20),
  batchSize: z.number().int().min(2).max(20).default(12),
}).strict();
export const weavePolicy = (config?: unknown) => WeavePolicySchema.parse(config ?? {});
