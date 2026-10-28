import { z } from "zod";

/** Shared configuration only; scheduling belongs to the Topic controller. */
export const ChiefTriggerConfigSchema = z.object({
  intervalSeconds: z.number().int().positive().max(2_147_483).default(60),
  idleSeconds: z.number().int().positive().max(2_147_483).default(900),
  backoff: z.object({
    factor: z.number().gt(1),
    maxIdleSeconds: z.number().int().positive().max(2_147_483),
  }).strict().optional(),
}).strict().refine(config => !config.backoff || config.backoff.maxIdleSeconds >= config.idleSeconds,
  { path: ["backoff", "maxIdleSeconds"], message: "Must be at least idleSeconds" });
export type ChiefTriggerConfig = z.infer<typeof ChiefTriggerConfigSchema>;
