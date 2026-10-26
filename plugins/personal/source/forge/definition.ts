import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { ForgeWatchSchema } from "./config.ts";
export const FORGE_SOURCE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "ForgeSource" } as const;
const record = z.record(z.string(), z.unknown());
export const ForgeSourceDefinition: ResourceDefinition = { type: FORGE_SOURCE_TYPE,
  schema: { spec: ForgeWatchSchema, status: z.object({
    cursor: z.string().optional(), batch: record.nullable().optional(), readPending: z.boolean().optional(),
    since: z.string().optional(), seed: z.array(record).nullable().optional(),
    initialized: z.boolean().optional(), sequence: z.number().int().nonnegative().optional(),
    tracked: z.record(z.string(), record).optional(), scan: record.nullable().optional(),
    scannedThrough: z.string().optional(), pending: record.nullable().optional(),
    refreshAfter: z.string().nullable().optional(), refreshedAt: z.string().optional(),
    lastObservedAt: z.string().optional(), error: z.string().nullable().optional(),
  }).strict() },
  retention: { releasedAt: () => undefined, references: r => r.status.pending ? [`input:${r.status.pending.name}`] : [] },
};
