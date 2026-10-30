import { SensitivitySchema, VisibilitySchema } from "../disclosure.ts";
import { AgentCallSchema } from "../observation/reference.ts";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { type ResourceDefinition } from "@compforge/aide-plugin";
import { OUTPUT_TYPE, type OutputSpec, type OutputStatus } from "./model.ts";
import { parseResourceNamespace } from "../../../src/host/plugin/namespace.ts";
import { AddressSchema } from "../../../src/address.ts";
import { isChannelAddress } from "../../../src/channel/address.ts";
import { outputPrinter } from "./printer.ts";
const ref = z.object({ apiVersion: z.string().min(1), kind: z.string().min(1), namespace: z.string().transform((value) => value === "v1" ? value : parseResourceNamespace(value)), name: z.string().min(1),
  uid: z.string().optional() }).strict();
export const OutputSpecSchema = z.object({
  text: z.string().min(1).max(128_000),
  notes: z.array(z.object({ uid: z.string().min(1), version: z.string().min(1), textVersion: z.string().min(1).optional() }).strict()).max(100).optional(),
  target: AddressSchema,
  receivers: z.array(ref.extend({ kind: z.literal("Person"), namespace: z.string().transform(parseResourceNamespace), uid: z.string().min(1) })).max(100).optional(),
  topic: ref.extend({ uid: z.string().min(1) }), topicId: z.string().min(1),
  inputUids: z.record(z.string(), z.string().min(1)).optional(), createdBy: AgentCallSchema.optional(),
  executionId: z.string().optional(), producer: ref.optional(), inputIds: z.array(z.string().min(1)).max(1001).optional(),
}).strict();
export const OutputStatusSchema = z.object({
  disclosure: z.object({ decision: z.enum(["allowed", "denied"]), reason: z.string(), checkedAt: z.iso.datetime(), fingerprint: z.string(), policy: z.object({ sensitivity: SensitivitySchema, visibility: VisibilitySchema, people: z.array(z.string()) }).strict().optional() }).strict().optional(),
  delivery: z.object({ replay: z.enum(["idempotent", "once"]).optional(), target: AddressSchema, text: z.string().max(160_000), receivers: z.array(ref) }).strict().optional(),
  phase: z.enum(["pending", "sending", "delivered", "failed", "uncertain"]), attempts: z.number().int().nonnegative(),
  deliveredAt: z.iso.datetime().optional(), lastError: z.string().max(4000).optional(), receipt: z.object({ id: z.string().min(1), scope: z.string().min(1) }).strict().optional() }).strict();


export const OutputDefinition: ResourceDefinition<OutputSpec, OutputStatus> = {
  indexes: { topic: r => [r.spec.topic.uid], webEndpoint: r => r.status.delivery && r.status.phase === "delivered" && isChannelAddress(r.status.delivery.target) && r.status.delivery.target.channelId === "web" ? [r.status.delivery.target.endpoint] : [] },
  type: OUTPUT_TYPE, schema: { spec: OutputSpecSchema, status: OutputStatusSchema }, printer: outputPrinter,
  validator: { update(previous, current) { if (!isDeepStrictEqual(previous.spec, current.spec)) throw new Error("Output content is immutable");
    if (previous.status.phase === "delivered" && current.status.phase !== "delivered") throw new Error("Delivered Output cannot be reopened");
    if ((previous.status.attempts > 0 || previous.status.phase === "delivered") && !isDeepStrictEqual(previous.status.delivery, current.status.delivery)) throw new Error("Attempted Output delivery is immutable");
    if (["sending", "delivered"].includes(current.status.phase) && (!current.status.delivery || !current.status.disclosure)) throw new Error("Output must be checked before delivery"); } },
  retention: { releasedAt: (r) => (r.status as OutputStatus).phase === "delivered" ? (r.status as OutputStatus).deliveredAt
    : (r.status as OutputStatus).phase === "failed" ? new Date(Date.parse(r.metadata.creationTimestamp) + 7 * 86400_000).toISOString() : undefined, references: () => [] },
};
