import { AgentStatusSchema } from "../session.ts";
import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { LoopExecutionSchema } from "../loop.ts";
import { ROUTE_NAME, ROUTE_TYPE, type RouteStatus } from "./model.ts";
export const RouteDefinition: ResourceDefinition<Record<string, never>, RouteStatus> = {
  type: ROUTE_TYPE,
  schema: { spec: z.object({}).strict(), status: z.object({
    agent: AgentStatusSchema.optional(), execution: LoopExecutionSchema.nullable().optional() }).strict() },
  validator: { create(resource) { if (resource.metadata.name !== ROUTE_NAME || resource.metadata.namespace !== "v1") throw new Error("Personal Route must be the global singleton"); } },
  retention: { releasedAt: () => undefined, references: () => [] },
};
