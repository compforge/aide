import type { Resource } from "@compforge/aide-plugin";
import type { WorkSpecFields, WorkStatus } from "../model.ts";

export const TASK_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Task" } as const;
export type TaskSpec = WorkSpecFields;
export type TaskResource = Resource<TaskSpec, WorkStatus>;
