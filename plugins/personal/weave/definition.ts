import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { AgentStatusSchema } from "../session.ts";
import { LoopExecutionSchema } from "../loop.ts";
import { GroupSchema, WEAVE_TYPE, WEAVE_NAME, type WeaveStatus } from "./model.ts";
export const WeaveDefinition: ResourceDefinition<Record<string, never>, WeaveStatus> = {
  type: WEAVE_TYPE,
  schema: { spec: z.object({}).strict(), status: z.object({
    agent: AgentStatusSchema.optional(), execution: LoopExecutionSchema.nullable().optional(),
    nextAt: z.string().datetime().optional(), lastRunAt: z.string().datetime().optional(), fingerprint: z.string().optional(), scanned: z.number().int().nonnegative().optional(), cursor: z.number().int().nonnegative().optional(),
    plan: GroupSchema.extend({ id: z.string(), at: z.string().datetime(), moving: z.boolean().optional() }).nullable().optional(),
  }).strict() },
  validator: { create(r) { if (r.metadata.name !== WEAVE_NAME || r.metadata.namespace !== "v1") throw new Error("Weave must be the global singleton"); } },
  retention: { releasedAt: () => undefined, references: () => [] },
};
