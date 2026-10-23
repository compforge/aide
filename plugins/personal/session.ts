import { z } from "zod";

/** Native binding only; history and checkpoints remain owned by the Harness. */
export const AgentStatusSchema = z.object({
  harness: z.string().min(1),
  targetId: z.string().min(1),
  session: z.object({
    id: z.string().min(1),
    resume: z.object({ version: z.number().int(), data: z.unknown() }).strict().optional(),
  }).strict().optional(),
}).strict();
