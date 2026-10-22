import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { digest } from "../../chief-model.ts";
export const ENVIRONMENT_SOURCE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "EnvironmentSource" } as const;
export const EnvironmentSourceDefinition: ResourceDefinition = { type: ENVIRONMENT_SOURCE_TYPE,
  schema: { spec: z.object({ environment: z.string(), namespace: z.string(), intervalMs: z.number().positive() }).strict(), status: z.object({ baseline: z.record(z.string(), z.unknown()).optional(), sequence: z.number().int().nonnegative().optional(), lastObservedAt: z.string().optional(), error: z.string().nullable().optional() }).strict() },
  retention: { releasedAt: () => undefined, references: (r) => [`input:${digest([r.metadata.uid, (r.status.sequence ?? 0) + 1])}`] },
};
