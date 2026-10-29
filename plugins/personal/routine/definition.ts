import { guardContext } from "../context-write.ts";
import { guardWork } from "../topic/work-guard.ts";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { WorkSpecSchema, TriggerSchema, validateTrigger } from "../model.ts";
import { RoutineStatusSchema } from "../work-status.ts";
import { ROUTINE_TYPE, type RoutineSpec, type RoutineStatus } from "./model.ts";
export const RoutineDefinition: ResourceDefinition<RoutineSpec, RoutineStatus> = {
  indexes: { topic: r => [r.status.topic.uid] },
  type: ROUTINE_TYPE, schema: { spec: WorkSpecSchema.extend({ trigger: TriggerSchema }), status: RoutineStatusSchema },
  validator: { create: (r, c) => { guardWork(r, c); validateTrigger("routine", r.spec.trigger, new Date()); }, update: (p, r, c) => { guardContext(p, r, c); guardWork(r, c, p); validateTrigger("routine", r.spec.trigger, new Date()); } },
};
