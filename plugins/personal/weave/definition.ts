import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { AgentStatusSchema } from "../session.ts";
import { LoopExecutionSchema } from "../loop.ts";
import { WEAVE_TYPE, WEAVE_NAME, type WeaveStatus } from "./model.ts";
export const WeaveDefinition: ResourceDefinition<Record<string, never>, WeaveStatus> = {
  type: WEAVE_TYPE,
  schema: { spec: z.object({}).strict(), status: z.object({
    agent: AgentStatusSchema.optional(), execution: LoopExecutionSchema.nullable().optional(),
    nextAt: z.string().datetime().optional(), lastRunAt: z.string().datetime().optional(),
    reviewed: z.record(z.string(), z.object({ version: z.string(), at: z.string().datetime() }).strict()).optional(),
  }).strict() },
  validator: { create(r) { if (r.metadata.name !== WEAVE_NAME || r.metadata.namespace !== "v1") throw new Error("Weave must be the global singleton"); } },
  retention: { releasedAt: () => undefined, references: () => [] },
};
