import type { Resource } from "@compforge/aide-plugin";
import { WorkSchema, validateTrigger, type Work, type Message, type Trigger } from "./model.ts";

export const TASK_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Task" } as const;
export const ROUTINE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Routine" } as const;
export const WORK_TYPES = [TASK_TYPE, ROUTINE_TYPE] as const;

export type TaskSpec = Pick<Work, "conversationId" | "title" | "instruction" | "revision" | "inputs">;
export type RoutineSpec = TaskSpec & { trigger: Trigger };
export type WorkSpec = TaskSpec | RoutineSpec;
type WorkObservation = Omit<Work, keyof TaskSpec | "id" | "kind" | "trigger">;
export interface Delivery {
  messages: Message[];
  inputs: Array<{ key: string; responseId: string }>;
  events: string[];
}
export type WorkStatus = WorkObservation & Delivery & { laneId?: string };
export type TaskResource = Resource<TaskSpec, WorkStatus>;
export type RoutineResource = Resource<RoutineSpec, WorkStatus>;
export type WorkResource = TaskResource | RoutineResource;

export function workType(kind: Work["kind"]) {
  return kind === "task" ? TASK_TYPE : ROUTINE_TYPE;
}

/** @spec Work is the tool/channel view of Task and Routine, not a persisted resource kind. */
export function toWork(resource: WorkResource): Work {
  if (resource.kind !== TASK_TYPE.kind && resource.kind !== ROUTINE_TYPE.kind) {
    throw new Error(`Not personal work: ${resource.kind}/${resource.metadata.name}`);
  }
  const { messages: _messages, inputs: _inputs, events: _events, laneId: _lane, ...observation } = resource.status;
  const kind = resource.kind === TASK_TYPE.kind ? "task" : "routine";
  const trigger = "trigger" in resource.spec ? resource.spec.trigger : null;
  const work = WorkSchema.parse({ id: resource.metadata.name, ...resource.spec, ...observation, kind, trigger });
  validateTrigger(kind, work.trigger, new Date());
  return work;
}
