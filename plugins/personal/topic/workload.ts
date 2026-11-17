import { z } from "zod";
import type { TopicResource } from "./model.ts";

export const ChiefWorkloadSchema = z.object({
  completed: z.number().int().nonnegative(), reviewed: z.number().int().nonnegative(),
  pendingSince: z.string().datetime().nullable().optional(),
  requestedThrough: z.number().int().nonnegative().optional(),
  afterRequestSince: z.string().datetime().nullable().optional(),
}).strict();
export type ChiefWorkload = z.infer<typeof ChiefWorkloadSchema>;
export const chiefWorkload = (topic: Readonly<TopicResource>): ChiefWorkload => topic.status.chiefWorkload
  ?? { completed: 0, reviewed: 0, pendingSince: null };
