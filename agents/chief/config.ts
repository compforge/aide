import { z } from "zod";

/** Shared configuration only; scheduling belongs to the Topic controller. */
export const ChiefTriggerConfigSchema = z.object({
  intervalSeconds: z.number().int().positive().max(2_147_483).default(60),
  idleSeconds: z.number().int().positive().max(2_147_483).default(900),
}).strict();
export type ChiefTriggerConfig = z.infer<typeof ChiefTriggerConfigSchema>;
