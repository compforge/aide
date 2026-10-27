import { z } from "zod";

export const DEFAULT_MAX_TOTAL_CONCURRENCY = 8;

/** New execution admission threshold; resumed continuations may exceed it. */
export const ReconcileConfigSchema = z.object({
  maxTotalConcurrency: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).default(DEFAULT_MAX_TOTAL_CONCURRENCY),
}).strict();
