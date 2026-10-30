import { workPhase, workDueAt } from "./status.ts";
import type { WorkAgentStatus } from "./work-status.ts";
import { WorkSchema, validateTrigger, type Work, type WorkStatus } from "./model.ts";
import { TASK_TYPE, type TaskSpec, type TaskResource } from "./task/model.ts";
import { ROUTINE_TYPE, type RoutineSpec, type RoutineResource } from "./routine/model.ts";

export const WORK_TYPES = [TASK_TYPE, ROUTINE_TYPE] as const;
export type WorkSpec = TaskSpec | RoutineSpec;
export type WorkResource = import("@compforge/aide-plugin").Resource<WorkSpec, WorkAgentStatus>;

export function workType(kind: Work["kind"]) {
  return kind === "task" ? TASK_TYPE : ROUTINE_TYPE;
}

/** @spec Work is the tool/channel view of Task and Routine, not a persisted resource kind. */
export function toWork(resource: WorkResource, topicId: string, recent: import("./note/model.ts").Note[] = [], summary = "", summaryNote?: import("./note/model.ts").NoteReference): Work {
  if (resource.kind !== TASK_TYPE.kind && resource.kind !== ROUTINE_TYPE.kind) {
    throw new Error(`Not personal work: ${resource.kind}/${resource.metadata.name}`);
  }
  const observation = resource.status;
  const kind = resource.kind === TASK_TYPE.kind ? "task" : "routine";
  const trigger = "trigger" in resource.spec ? resource.spec.trigger : null;
  const work = WorkSchema.parse({ id: resource.metadata.name, uid: resource.metadata.uid, ...resource.spec, ...observation, summary, summaryUid: summaryNote?.uid ?? "", summaryNote, recent, topicId, kind, trigger, revision: resource.metadata.generation, status: workPhase(resource), nextAt: workDueAt(resource), question: resource.status.waiting?.question ?? null });
  validateTrigger(kind, work.trigger, new Date());
  return work;
}
