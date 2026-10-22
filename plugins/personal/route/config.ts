import { z } from "zod";
export const RoutePolicySchema = z.object({
  batchSize: z.number().int().min(1).max(100).default(16),
  maxWaitSeconds: z.number().int().min(1).max(3600).default(5),
  contextChars: z.number().int().min(8192).max(200_000).default(64_000),
  summaryChars: z.number().int().min(256).max(8000).default(2000),
}).strict();
export const routePolicy = (config?: unknown) => RoutePolicySchema.parse(config ?? {});
