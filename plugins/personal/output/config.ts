import { z } from "zod";

export const OutputPolicySchema = z.object({
  maxAttempts: z.number().int().positive().default(5),
}).strict();
export type OutputPolicy = z.infer<typeof OutputPolicySchema>;
export const outputPolicy = (input?: unknown): OutputPolicy => OutputPolicySchema.parse(input ?? {});
