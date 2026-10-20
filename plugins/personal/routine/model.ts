import type { Resource } from "@compforge/aide-plugin";
import type { WorkSpecFields, WorkStatus, Trigger } from "../model.ts";

export const ROUTINE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Routine" } as const;
export type RoutineSpec = WorkSpecFields & { trigger: Trigger };
export type RoutineResource = Resource<RoutineSpec, WorkStatus>;
