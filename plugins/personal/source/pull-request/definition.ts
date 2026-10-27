import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { PullRequestSourceSpecSchema } from "./config.ts";
export const PULL_REQUEST_SOURCE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "PullRequestSource" } as const;
const record = z.record(z.string(), z.unknown());
export const PullRequestSourceDefinition: ResourceDefinition = { type: PULL_REQUEST_SOURCE_TYPE,
  schema: { spec: PullRequestSourceSpecSchema, status: z.object({
    snapshot: z.object({ value: z.record(z.string(), record), observedAt: z.string() }).strict().optional(),
    initialSince: z.string().optional(), inputSince: z.string().optional(),
    scanPending: z.boolean().optional(), scanComplete: z.boolean().optional(), issues: z.array(record).optional(),
    cursor: z.string().optional(), batch: record.nullable().optional(),
    sequence: z.number().int().nonnegative().optional(), pending: record.nullable().optional(),
    lastObservedAt: z.string().optional(), retiredAt: z.string().nullable().optional(), error: z.string().nullable().optional(),
  }).strict() },
  retention: { releasedAt: r => r.status.pending || r.status.batch ? undefined : r.status.retiredAt ?? undefined,
    references: r => r.status.pending ? [`input:${r.status.pending.name}`] : [] },
  indexes: { repositorySource: r => r.spec.repositorySource ? [r.spec.repositorySource.uid] : [] },
};
