import { z } from "zod";
export const TaskPolicySchema = z.object({
  agentIdleMs: z.number().int().min(1000).max(2_147_483_647).default(5 * 60_000),
  idleRetentionMs: z.number().int().min(1000).max(2_147_483_647).default(24 * 60 * 60_000),
}).strict();
export const taskPolicy = (input: unknown) => TaskPolicySchema.parse(input ?? {});
