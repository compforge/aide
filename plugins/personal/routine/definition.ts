import type { ResourceDefinition } from "@compforge/aide-plugin";
import { WorkSpecSchema, WorkStatusSchema, TriggerSchema, validateTrigger } from "../model.ts";
import { ROUTINE_TYPE } from "./model.ts";
export const RoutineDefinition: ResourceDefinition = {
  type: ROUTINE_TYPE, scope: "shared", schema: { spec: WorkSpecSchema.extend({ trigger: TriggerSchema }), status: WorkStatusSchema },
  validator: { create: (r) => validateTrigger("routine", r.spec.trigger, new Date()), update: (_old, r) => validateTrigger("routine", r.spec.trigger, new Date()) },
};
