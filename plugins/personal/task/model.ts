import type { Resource } from "@compforge/aide-plugin";
import type { WorkSpecFields } from "../work/model.ts";
import type { WorkAgentStatus } from "../work/agent-status.ts";
export const TASK_TYPE = { apiVersion: "aide.dev/v1alpha4", kind: "Task" } as const;
export type TaskSpec = WorkSpecFields & { initialInputId: string };
export type TaskStatus = Omit<WorkAgentStatus, "lastOccurrence" | "nextTriggerAt">;
export type TaskResource = Resource<TaskSpec, TaskStatus>;
