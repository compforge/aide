import { AddressRefSchema } from "../address/model.ts";
import { canEvictOutput } from "./frequency.ts";
import { PersonRefsSchema } from "../person/model.ts";
import { SensitivitySchema, VisibilitySchema } from "../disclosure.ts";
import { AgentCallSchema } from "../observation/reference.ts";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { type ResourceDefinition } from "@compforge/aide-plugin";
import { OUTPUT_TYPE, receiverIdentity, type OutputSpec, type OutputStatus } from "./model.ts";
import { parseResourceNamespace } from "../../../src/host/plugin/namespace.ts";
import { AddressSchema } from "../../../src/address.ts";
import { isChannelAddress } from "../../../src/channel/address.ts";
import { outputPrinter } from "./printer.ts";
const ref = z.object({ apiVersion: z.string().min(1), kind: z.string().min(1), namespace: z.string().transform((value) => value === "v1" ? value : parseResourceNamespace(value)), name: z.string().min(1),
  uid: z.string().optional() }).strict();
export const OutputSpecSchema = z.object({
  text: z.string().min(1).max(128_000),
  notes: z.array(z.object({ uid: z.string().min(1), version: z.string().min(1), textVersion: z.string().min(1).optional() }).strict()).max(100).optional(),
  target: AddressRefSchema,
  replyTo: z.object({ input: ref.extend({ uid: z.string().min(1) }), key: z.string().min(1), messageId: z.string().optional() }).strict().optional(),
  replyToMessageId: z.string().optional(),
  receivers: PersonRefsSchema(100).optional(),
  topic: ref.extend({ uid: z.string().min(1) }), topicId: z.string().min(1),
  inputUids: z.record(z.string(), z.string().min(1)).optional(), createdBy: AgentCallSchema.optional(),
  executionId: z.string().optional(), producer: ref.optional(), inputIds: z.array(z.string().min(1)).max(1001).optional(),
}).strict();
export const OutputStatusSchema = z.object({
  disclosure: z.object({ decision: z.enum(["allowed", "denied"]), reason: z.string(), checkedAt: z.iso.datetime(), fingerprint: z.string(), policy: z.object({ sensitivity: SensitivitySchema, visibility: VisibilitySchema, people: z.array(z.string()) }).strict().optional() }).strict().optional(),
  waitingAddress: AddressRefSchema.optional(),
  delivery: z.object({ notice: z.literal("muted").optional(), address: AddressRefSchema, replay: z.enum(["idempotent", "once"]).optional(), target: AddressSchema, text: z.string().max(160_000), receivers: PersonRefsSchema() }).strict().optional(),
  phase: z.enum(["pending", "sending", "delivered", "failed", "uncertain", "cancelled"]), attempts: z.number().int().nonnegative(),
  deliveryWait: z.object({ reason: z.enum(["frequency", "receiver-busy", "provider"]), until: z.iso.datetime() }).strict().optional(),
  deliveredAt: z.iso.datetime().optional(), lastError: z.string().max(4000).optional(), receipt: z.object({ id: z.string().min(1), scope: z.string().min(1) }).strict().optional() }).strict();


export const OutputDefinition: ResourceDefinition<OutputSpec, OutputStatus> = {
  indexes: { reply: r => r.spec.replyTo ? [r.spec.replyTo.key] : [], address: r => [r.spec.target.uid], pendingAddress: r => ["pending", "sending"].includes(r.status.phase) ? [...new Set([r.spec.target.uid, r.status.delivery?.address.uid, r.status.waitingAddress?.uid].filter((uid): uid is string => !!uid))] : [], pendingReceiver: r => ["pending", "sending"].includes(r.status.phase) ? [...r.status.delivery?.receivers ?? []].map(p => p.uid) : [], topic: r => [r.spec.topic.uid], webEndpoint: r => r.status.delivery && r.status.phase === "delivered" && isChannelAddress(r.status.delivery.target) && r.status.delivery.target.channelId === "web" ? [r.status.delivery.target.endpoint] : [] },
  orderedIndexes: { deliveredPerson: r => r.status.phase === "delivered" && r.status.deliveredAt
    ? [...r.status.delivery?.receivers ?? []].map(p => ({ value: p.uid, order: r.status.deliveredAt! })) : [] },
  type: OUTPUT_TYPE, schema: { spec: OutputSpecSchema, status: OutputStatusSchema }, printer: outputPrinter,
  validator: { create(current, context) {
    if (current.spec.replyTo && context.page(OUTPUT_TYPE, { limit: 2, matchIndex: { name: "reply", value: current.spec.replyTo.key } }).items.some(o => o.metadata.uid !== current.metadata.uid)) throw new Error("Message already has a reply Output");
  }, update(previous, current) { if (!isDeepStrictEqual(receiverIdentity(previous.spec), receiverIdentity(current.spec))) throw new Error("Output content is immutable");
    if (previous.status.phase === "cancelled" && current.status.phase !== "cancelled") throw new Error("Cancelled Output cannot be reopened");
    if (previous.status.phase === "delivered" && current.status.phase !== "delivered") throw new Error("Delivered Output cannot be reopened");
    if ((previous.status.attempts > 0 || previous.status.phase === "delivered") && !isDeepStrictEqual(receiverIdentity(previous.status.delivery), receiverIdentity(current.status.delivery))) throw new Error("Attempted Output delivery is immutable");
    if (["sending", "delivered"].includes(current.status.phase) && (!current.status.delivery || !current.status.disclosure)) throw new Error("Output must be checked before delivery"); } },
  retention: { canEvict: canEvictOutput, releasedAt: (r) => (r.status as OutputStatus).phase === "delivered" ? (r.status as OutputStatus).deliveredAt
    : ["failed", "cancelled"].includes((r.status as OutputStatus).phase) ? new Date(Date.parse(r.metadata.creationTimestamp) + 7 * 86400_000).toISOString() : undefined, references: () => [] },
};
