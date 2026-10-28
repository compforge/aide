import type { Resource } from "@compforge/aide-plugin";
import type { WorkSpecFields, Trigger } from "../model.ts";

import type { WorkAgentStatus } from "../work-status.ts";

export const ROUTINE_TYPE = { apiVersion: "aide.dev/v1alpha2", kind: "Routine" } as const;
export type RoutineSpec = WorkSpecFields & { trigger: Trigger };
export type RoutineStatus = Omit<WorkAgentStatus, "completion">;
export type RoutineResource = Resource<RoutineSpec, RoutineStatus>;
