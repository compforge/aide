import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { WatchSchema } from "./config.ts";
export const SOURCE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "RequirementSource" } as const;
const record = z.record(z.string(), z.unknown());
export const RequirementSourceDefinition: ResourceDefinition = { type: SOURCE_TYPE,
  schema: { spec: WatchSchema.extend({ topicKey: z.string(), me: z.object({ userKey: z.string().trim().min(1) }).strict().optional() }), status: z.object({ scope: z.string().optional(), sequence: z.number().int().nonnegative().optional(),
    tracked: z.record(z.string(), record).optional(), scan: record.nullable().optional(), scannedThrough: z.string().nullable().optional(), pending: record.nullable().optional(),
    lastObservedAt: z.string().optional(), error: z.string().nullable().optional() }).strict() },
  retention: { releasedAt: () => undefined, references: (r) => r.status.pending ? [`input:${r.status.pending.name}`] : [] },
};
