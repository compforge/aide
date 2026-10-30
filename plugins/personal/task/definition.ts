import { workPhase } from "../status.ts";
import { guardContext } from "../context-write.ts";
import { guardWork } from "../topic/work-guard.ts";
import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { WorkSpecSchema } from "../model.ts";
import { TaskStatusSchema } from "../work-status.ts";
import { TASK_TYPE, type TaskSpec, type TaskStatus } from "./model.ts";
export const TaskDefinition: ResourceDefinition<TaskSpec, TaskStatus> = {
  indexes: { active: r => r.status.execution ? [r.status.topic.uid] : [], topic: r => [r.status.topic.uid], maintenance: r => !r.metadata.deletionTimestamp && workPhase(r) !== "done" ? [r.status.topic.uid] : [] },
  validator: { create: (r, c) => guardWork(r, c), update: (p, r, c) => { guardContext(p, r, c); guardWork(r, c, p); } },
  type: TASK_TYPE, schema: { spec: WorkSpecSchema.extend({ initialInputId: z.string().min(1) }), status: TaskStatusSchema },
};
