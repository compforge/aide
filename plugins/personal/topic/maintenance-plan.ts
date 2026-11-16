import { z } from "zod";
import { NotePressureSchema } from "../note/pressure.ts";

/** Durable preparation evidence, consumed by Secretary after the Input has a terminal receipt. */
export const MaintenancePlanSchema = z.object({
  materialVersion: z.string(), lastInputAt: z.string().optional(), weaveRevision: z.number().int().nonnegative(),
  absorption: z.array(z.object({ uid: z.string(), parentUid: z.string(), version: z.string() }).strict()),
  notePressure: z.array(z.object({ uid: z.string(), name: z.string().optional(), pressure: NotePressureSchema }).strict()).max(8),
}).strict();
export type MaintenancePlan = z.infer<typeof MaintenancePlanSchema>;
