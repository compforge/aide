import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { WorkSpecSchema, WorkStatusSchema } from "../model.ts";
import { AgentStatusSchema } from "../session.ts";
import { LoopExecutionSchema } from "../loop.ts";
import { TASK_TYPE, type TaskSpec, type TaskStatus } from "./model.ts";
export const TaskDefinition: ResourceDefinition<TaskSpec, TaskStatus> = {
  type: TASK_TYPE, schema: { spec: WorkSpecSchema.extend({ initialInputId: z.string().min(1) }),
    status: WorkStatusSchema.extend({ agent: AgentStatusSchema.optional(), execution: LoopExecutionSchema.nullable().optional(),
      idleSince: z.string().nullable().optional(), agentStoppedAt: z.string().nullable().optional(), lastExecutionId: z.string().optional() }) },
};
