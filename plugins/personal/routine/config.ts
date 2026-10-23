import { z } from "zod";
export const RoutinePolicySchema = z.object({
  agentIdleMs: z.number().int().min(1000).max(2_147_483_647).default(5 * 60_000),
}).strict();
export const routinePolicy = (input: unknown) => RoutinePolicySchema.parse(input ?? {});
