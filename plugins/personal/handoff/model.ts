import { PersonRefSchema } from "../person/model.ts";
import { z } from "zod";
import type { Resource, ResourceDefinition } from "@compforge/aide-plugin";
import { isDeepStrictEqual } from "node:util";
import { ResourceRefSchema } from "../topic/ref.ts";
import { AddressRefSchema } from "../address/model.ts";

export const HANDOFF_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Handoff" } as const;
export const EvidenceRefSchema = z.object({ apiVersion: z.string(), kind: z.string(), namespace: z.literal("v1"), name: z.string().min(1), uid: z.string().min(1) }).strict();
export const HandoffSpecSchema = z.object({
  gate: ResourceRefSchema, sourceInput: EvidenceRefSchema, topic: ResourceRefSchema.optional(),
  sourceText: z.string(), replyTo: AddressRefSchema, title: z.string().min(1).max(200), request: z.string().min(1).max(16000),
}).strict();
export const HandoffStatusSchema = z.object({
  reply: z.object({ address: AddressRefSchema, sender: PersonRefSchema.optional(), messageId: z.string().optional() }).strict(),
  sourceInput: EvidenceRefSchema, sourceText: z.string(),
  latestInputId: z.string().min(1), request: z.string(), topic: ResourceRefSchema.optional(), sequence: z.number().int().positive(),
  phase: z.enum(["submitted", "accepted", "working", "waiting", "completed", "failed"]),
  receivedAt: z.string().optional(), updatedAt: z.string(), report: z.string().max(4000).optional(),
  reportKey: z.string().optional(), works: z.array(EvidenceRefSchema).default([]),
}).strict();
export type HandoffSpec = z.infer<typeof HandoffSpecSchema>;
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>;
export type Handoff = Resource<HandoffSpec, HandoffStatus>;

/** @spec Handoff retains conversation continuity independently of short-lived Inputs; it owns neither execution nor domain knowledge.
 * @link docs/personal/gate.md
 */
export const HandoffDefinition: ResourceDefinition<HandoffSpec, HandoffStatus> = {
  type: HANDOFF_TYPE, schema: { spec: HandoffSpecSchema, status: HandoffStatusSchema },
  orderedIndexes: { gateActivity: r => [{ value: r.spec.gate.uid, order: r.metadata.creationTimestamp }] },
  indexes: { gate: r => [r.spec.gate.uid], input: r => [r.status.latestInputId],
    activeTopic: r => ["completed", "failed"].includes(r.status.phase) ? [] : r.status.topic ? [r.status.topic.uid] : [] },
  validator: { update(previous, current) {
    if (!isDeepStrictEqual(previous.spec, current.spec)) throw new Error("Handoff identity and original request are immutable");
    if (current.status.sequence < previous.status.sequence) throw new Error("Handoff sequence cannot move backwards");
  } },
  retention: { releasedAt: r => ["completed", "failed"].includes(r.status.phase) ? r.status.updatedAt : undefined, references: () => [] },
};

/** Bounded directory/background projection; original evidence is available through read_handoff. */
export function handoffSummary(value: Handoff) {
  const preview = (text: string, size: number) => text.length > size ? text.slice(0, size) + "…" : text;
  return { metadata: value.metadata, spec: { title: value.spec.title }, status: {
    topic: value.status.topic, latestInputId: value.status.latestInputId, sequence: value.status.sequence,
    phase: value.status.phase, updatedAt: value.status.updatedAt,
    request: preview(value.status.request, 500), ...(value.status.report ? { report: preview(value.status.report, 500) } : {}),
  } };
}
export type HandoffSummary = ReturnType<typeof handoffSummary>;
