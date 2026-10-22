import { z } from "zod";
import type { ResourceDefinition } from "@compforge/aide-plugin";
import { digest } from "../../chief-model.ts";
import { MessageWatchSchema } from "./config.ts";
export const MESSAGE_SOURCE_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "MessageSource" } as const;
export const MessageSourceDefinition: ResourceDefinition = { type: MESSAGE_SOURCE_TYPE, scope: "shared",
  schema: { spec: MessageWatchSchema.extend({ accountId: z.string(), userId: z.string(), personIds: z.array(z.string()) }), status: z.object({ scans: z.array(z.record(z.string(), z.unknown())).optional(), pending: z.array(z.record(z.string(), z.unknown())).optional(), lastObservedAt: z.string().optional(), error: z.string().nullable().optional() }).strict() },
  retention: { releasedAt: () => undefined, references: (r) => r.status.pending?.flatMap((e: any) => [`input:${digest(["lark", r.spec.accountId, r.spec.userId, e.message.id, 0])}`, ...(e.delivery ? [`input:${e.delivery.name}`] : [])]) ?? [] },
};
