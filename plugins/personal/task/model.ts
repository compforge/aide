import type { Resource } from "@compforge/aide-plugin";
import type { WorkSpecFields } from "../model.ts";
import type { WorkAgentStatus } from "../work-status.ts";
export const TASK_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Task" } as const;
export type TaskSpec = WorkSpecFields & { initialInputId: string };
export type TaskStatus = WorkAgentStatus;
export type TaskResource = Resource<TaskSpec, TaskStatus>;
