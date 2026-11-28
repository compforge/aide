import type { Input } from "../input/state.ts";
import { z } from "zod";
import type { Resource } from "@compforge/aide-plugin";
import { digest } from "../identity.ts";
import { ResourceRefSchema } from "../topic/ref.ts";

export const DEFAULT_CHECK_INTERVAL_MS = 3_600_000;
export const ONGOING_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Ongoing" } as const;
export const OngoingSpecSchema = z.object({
  topic: ResourceRefSchema, sourceUid: z.string().optional(), title: z.string().trim().min(1).max(200),
  question: z.string().trim().min(1).max(1000).optional(), initialInputId: z.string().min(1).optional(),
}).strict();
export const OngoingStatusSchema = z.object({
  updatedAt: z.iso.datetime(), progress: z.string().trim().min(1).max(4000).optional(),
  closure: z.object({ at: z.iso.datetime(), outcome: z.string().trim().min(1).max(2000) }).strict().optional(),
  writer: z.object({ resource: ResourceRefSchema, executionId: z.string().min(1) }).strict(),
  nextCheckAt: z.iso.datetime().optional(), followupInputId: z.string().optional(),
}).strict();
export type OngoingSpec = z.infer<typeof OngoingSpecSchema>;
export type OngoingStatus = z.infer<typeof OngoingStatusSchema>;
export type OngoingResource = Resource<OngoingSpec, OngoingStatus>;

export function followupInputId(matter: OngoingResource) {
  if (!matter.metadata.deletionTimestamp && !matter.status.closure && matter.status.nextCheckAt)
    return `followup-${digest([matter.metadata.uid, matter.metadata.resourceVersion])}`;
}
/** A matching delivered appointment advances once. A retained future plan always wins. */
export function nextCheckAfterDelivery(matter: OngoingResource, input: Input, deliveredAt: string) {
  if (matter.status.closure || matter.metadata.deletionTimestamp || matter.status.followupInputId !== input.metadata.name
      || input.spec.observation?.ongoingUid !== matter.metadata.uid || input.spec.observation.dueAt !== matter.status.nextCheckAt) return;
  return new Date(Date.parse(deliveredAt) + DEFAULT_CHECK_INTERVAL_MS).toISOString();
}
/** Retention can remove a historical reminder after its appointment was consumed. Start a new interval from that appointment. */
export function nextCheckAfterRetention(matter: OngoingResource) {
  if (matter.status.closure || !matter.status.followupInputId || !matter.status.nextCheckAt) return;
  return new Date(Date.parse(matter.status.nextCheckAt) + DEFAULT_CHECK_INTERVAL_MS).toISOString();
}
export function ongoingView(matter: OngoingResource) {
  return { id: matter.metadata.name, kind: "ongoing" as const, status: matter.status.closure ? "closed" as const : "open" as const, uid: matter.metadata.uid, version: matter.metadata.resourceVersion,
    ...matter.spec, checkAt: matter.status.nextCheckAt, progress: matter.status.progress, closure: matter.status.closure };
}
