import { guardWork } from "../topic/work-guard.ts";
import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { WorkSpecSchema } from "../model.ts";
import { WorkAgentStatusSchema } from "../work-status.ts";
import { TASK_TYPE, type TaskSpec, type TaskStatus } from "./model.ts";
export const TaskDefinition: ResourceDefinition<TaskSpec, TaskStatus> = {
  validator: { create: (r, c) => guardWork(r, c), update: (p, r, c) => guardWork(r, c, p) },
  type: TASK_TYPE, schema: { spec: WorkSpecSchema.extend({ initialInputId: z.string().min(1) }), status: WorkAgentStatusSchema },
};
