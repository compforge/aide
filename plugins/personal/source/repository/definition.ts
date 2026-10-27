import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { RepositorySourceSpecSchema } from "./config.ts";
export const REPOSITORY_SOURCE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "RepositorySource" } as const;
const record = z.record(z.string(), z.unknown());
export const RepositorySourceDefinition: ResourceDefinition = { type: REPOSITORY_SOURCE_TYPE,
  schema: { spec: RepositorySourceSpecSchema, status: z.object({
    snapshot: z.object({ value: z.array(record), observedAt: z.string() }).strict().optional(),
    refresh: z.object({ startedAt: z.string(), cursor: z.string().optional(), items: z.array(record) }).strict().nullable().optional(),
    handoff: z.object({ offset: z.number().int().nonnegative(), policyKey: z.string() }).strict().nullable().optional(),
    retryAt: z.string().nullable().optional(), issues: z.array(record).optional(),
    error: z.string().nullable().optional(), retiredAt: z.string().nullable().optional(),
  }).strict() },
  retention: { releasedAt: r => r.status.retiredAt ?? undefined, references: () => [] },
};
