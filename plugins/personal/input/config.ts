import { z } from "zod";

const seconds = z.number().int().positive().max(31_536_000);
export const InputPolicySchema = z.object({
  retention: z.object({ successSeconds: seconds.default(86400), errorSeconds: seconds.default(7 * 86400) })
    .strict().prefault({}).refine(p => p.errorSeconds > p.successSeconds, { message: "errorSeconds must exceed successSeconds" }),
}).strict();
export const inputPolicy = (config?: unknown) => InputPolicySchema.parse(config ?? {});
