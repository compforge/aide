import type { ResourceDefinition } from "@compforge/aide-plugin";
import { WorkSpecSchema, TriggerSchema, validateTrigger } from "../model.ts";
import { WorkAgentStatusSchema } from "../work-status.ts";
import { ROUTINE_TYPE, type RoutineSpec, type RoutineStatus } from "./model.ts";
export const RoutineDefinition: ResourceDefinition<RoutineSpec, RoutineStatus> = {
  type: ROUTINE_TYPE, schema: { spec: WorkSpecSchema.extend({ trigger: TriggerSchema }), status: WorkAgentStatusSchema },
  validator: { create: (r) => validateTrigger("routine", r.spec.trigger, new Date()), update: (_old, r) => validateTrigger("routine", r.spec.trigger, new Date()) },
};
