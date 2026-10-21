import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { WatchSchema } from "./config.ts";
export const SOURCE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "RequirementSource" } as const;
export const RequirementSourceDefinition: ResourceDefinition = { type: SOURCE_TYPE, scope: "session",
  schema: { spec: WatchSchema.extend({ sessionId: z.string() }), status: z.object({ pendingInputIds: z.array(z.string()).optional(), seen: z.record(z.string(), z.string()).optional(), lastObservedAt: z.string().optional(), error: z.string().nullable().optional() }).strict() },
  retention: { releasedAt: () => undefined, references: (r) => r.status.pendingInputIds?.map((id: string) => `input:${id}`) ?? [] },
};
