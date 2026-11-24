import { z } from "zod";
import type { Resource } from "@compforge/aide-plugin";
import { digest } from "../identity.ts";
import { ResourceRefSchema } from "../topic/ref.ts";

export const ONGOING_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Ongoing" } as const;
export const OngoingSpecSchema = z.object({
  topic: ResourceRefSchema, title: z.string().trim().min(1).max(200),
  question: z.string().trim().min(1).max(1000).optional(), checkAt: z.iso.datetime().optional(),
}).strict();
export const OngoingStatusSchema = z.object({
  updatedAt: z.iso.datetime(), progress: z.string().trim().min(1).max(4000).optional(),
  closure: z.object({ at: z.iso.datetime(), outcome: z.string().trim().min(1).max(2000) }).strict().optional(),
  writer: z.object({ resource: ResourceRefSchema, executionId: z.string().min(1) }).strict(),
  planRevision: z.number().int().positive(), followupInputId: z.string().optional(), askedFollowupId: z.string().optional(),
}).strict();
export type OngoingSpec = z.infer<typeof OngoingSpecSchema>;
export type OngoingStatus = z.infer<typeof OngoingStatusSchema>;
export type OngoingResource = Resource<OngoingSpec, OngoingStatus>;

export function followupInputId(matter: OngoingResource) {
  if (!matter.metadata.deletionTimestamp && !matter.status.closure && matter.spec.checkAt)
    return `followup-${digest([matter.metadata.uid, matter.status.planRevision])}`;
}
export function ongoingView(matter: OngoingResource) {
  return { id: matter.metadata.name, kind: "ongoing" as const, status: matter.status.closure ? "closed" as const : "open" as const, uid: matter.metadata.uid, version: matter.metadata.resourceVersion,
    ...matter.spec, progress: matter.status.progress, closure: matter.status.closure };
}
