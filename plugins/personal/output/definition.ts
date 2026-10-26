import { AgentCallSchema } from "../observation/reference.ts";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { type ResourceDefinition } from "@compforge/aide-plugin";
import { OUTPUT_TYPE, type OutputSpec, type OutputStatus } from "./model.ts";
import { parseResourceNamespace } from "../../../src/host/plugin/namespace.ts";
import { AddressSchema } from "../../../src/address.ts";
import { outputPrinter } from "./printer.ts";
const ref = z.object({ apiVersion: z.string().min(1), kind: z.string().min(1), namespace: z.string().transform((value) => value === "v1" ? value : parseResourceNamespace(value)), name: z.string().min(1),
  uid: z.string().optional() }).strict();
export const OutputSpecSchema = z.object({
  text: z.string().min(1).max(128_000),
  target: AddressSchema,
  receivers: z.array(ref.extend({ kind: z.literal("Person"), namespace: z.string().transform(parseResourceNamespace), uid: z.string().min(1) })).max(100).optional(),
  topic: ref.extend({ uid: z.string().min(1) }), topicId: z.string().min(1),
  inputUids: z.record(z.string(), z.string().min(1)).optional(), createdBy: AgentCallSchema.optional(),
  executionId: z.string().optional(), producer: ref.optional(), inputIds: z.array(z.string().min(1)).max(1001).optional(),
}).strict();
export const OutputStatusSchema = z.object({ phase: z.enum(["pending", "sending", "delivered", "failed", "uncertain"]), attempts: z.number().int().nonnegative(),
  nextAttemptAt: z.iso.datetime().optional(), deliveredAt: z.iso.datetime().optional(), lastError: z.string().max(4000).optional(), receipt: z.object({ id: z.string().min(1), scope: z.string().min(1) }).strict().optional() }).strict();


export const OutputDefinition: ResourceDefinition<OutputSpec, OutputStatus> = {
  type: OUTPUT_TYPE, schema: { spec: OutputSpecSchema, status: OutputStatusSchema }, printer: outputPrinter,
  validator: { update(previous, current) { if (!isDeepStrictEqual(previous.spec, current.spec)) throw new Error("Output content is immutable"); } },
  retention: { releasedAt: (r) => (r.status as OutputStatus).phase === "delivered" ? (r.status as OutputStatus).deliveredAt
    : (r.status as OutputStatus).phase === "failed" ? new Date(Date.parse(r.metadata.creationTimestamp) + 7 * 86400_000).toISOString() : undefined, references: () => [] },
};
