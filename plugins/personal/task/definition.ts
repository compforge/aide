import type { ResourceDefinition } from "@compforge/aide-plugin";
import { WorkSpecSchema, WorkStatusSchema } from "../model.ts";
import { TASK_TYPE } from "./model.ts";
export const TaskDefinition: ResourceDefinition = {
  type: TASK_TYPE, scope: "shared", schema: { spec: WorkSpecSchema, status: WorkStatusSchema },
};
