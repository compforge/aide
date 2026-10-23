import type { Resource } from "@compforge/aide-plugin";
import type { WorkSpecFields, WorkStatus } from "../model.ts";
import type { LoopStatus } from "../loop.ts";
export const TASK_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Task" } as const;
export type TaskSpec = WorkSpecFields & { initialInputId: string };
export interface TaskStatus extends WorkStatus, LoopStatus {
  idleSince?: string | null;
  agentStoppedAt?: string | null;
  lastExecutionId?: string;
}
export type TaskResource = Resource<TaskSpec, TaskStatus>;
