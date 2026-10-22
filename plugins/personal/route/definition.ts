import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { ROUTE_NAME, ROUTE_TYPE, type RouteStatus } from "./model.ts";
export const DestinationSchema = z.object({ name: z.string().min(1), uid: z.string().min(1) }).strict();
export const DecisionSchema = z.object({ inputId: z.string().min(1), destinations: z.array(DestinationSchema), reason: z.string() }).strict();
export const RouteDefinition: ResourceDefinition<Record<string, never>, RouteStatus> = {
  type: ROUTE_TYPE,
  schema: { spec: z.object({}).strict(), status: z.object({ pendingInputIds: z.array(z.string()).default([]),
    batch: z.object({ id: z.string(), inputIds: z.array(z.string()), createdAt: z.string(), phase: z.enum(["queued", "running", "planned"]),
      prompt: z.string(), candidates: z.array(DestinationSchema.extend({ id: z.string(), nameHint: z.string(), summary: z.string(), default: z.boolean() })),
      plan: z.array(DecisionSchema).optional(),
    }).strict().nullable().optional() }).strict() },
  validator: { create(resource) { if (resource.metadata.name !== ROUTE_NAME || resource.metadata.namespace !== "v1") throw new Error("Personal Route must be the global singleton"); } },
  retention: { releasedAt: () => undefined, references: r => [...new Set([...r.status.pendingInputIds, ...r.status.batch?.inputIds ?? []])].map(id => `input:${id}`) },
};
