import { z } from "zod";
import { WorkStatusSchema, type WorkStatus } from "./model.ts";
import { AgentStatusSchema } from "./session.ts";
import { LoopExecutionSchema, type LoopStatus } from "./loop.ts";
export interface WorkAgentStatus extends WorkStatus, LoopStatus {
  idleSince?: string | null;
  agentStoppedAt?: string | null;
  lastExecutionId?: string;
}
export const WorkAgentStatusSchema = WorkStatusSchema.extend({
  agent: AgentStatusSchema.optional(), execution: LoopExecutionSchema.nullable().optional(),
  idleSince: z.string().nullable().optional(), agentStoppedAt: z.string().nullable().optional(), lastExecutionId: z.string().optional(),
});
