import { WorkSchema, validateTrigger, type Work } from "./model.ts";
import { TASK_TYPE, type TaskSpec, type TaskResource } from "./task/model.ts";
import { ROUTINE_TYPE, type RoutineSpec, type RoutineResource } from "./routine/model.ts";

export const WORK_TYPES = [TASK_TYPE, ROUTINE_TYPE] as const;
export type WorkSpec = TaskSpec | RoutineSpec;
export type WorkResource = TaskResource | RoutineResource;

export function workType(kind: Work["kind"]) {
  return kind === "task" ? TASK_TYPE : ROUTINE_TYPE;
}

/** @spec Work is the tool/channel view of Task and Routine, not a persisted resource kind. */
export function toWork(resource: WorkResource): Work {
  if (resource.kind !== TASK_TYPE.kind && resource.kind !== ROUTINE_TYPE.kind) {
    throw new Error(`Not personal work: ${resource.kind}/${resource.metadata.name}`);
  }
  const { inputs: _inputs, events: _events, ...observation } = resource.status;
  const kind = resource.kind === TASK_TYPE.kind ? "task" : "routine";
  const trigger = "trigger" in resource.spec ? resource.spec.trigger : null;
  const work = WorkSchema.parse({ id: resource.metadata.name, uid: resource.metadata.uid, ...resource.spec, ...observation, kind, trigger });
  validateTrigger(kind, work.trigger, new Date());
  return work;
}
