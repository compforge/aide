import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { type ResourceDefinition } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "./model.ts";
import { AddressSchema } from "../../../src/address.ts";
import { parseResourceNamespace } from "../../../src/host/plugin/namespace.ts";
import { inputPrinter } from "./printer.ts";
export const InputSpecSchema = z.object({ source: AddressSchema.optional(), sessionId: z.string().min(1).max(200).optional(), origin: z.enum(["channel", "source"]),
  originId: z.string().min(1), relation: z.enum(["sent", "received", "observed"]).optional(),
  sender: z.object({ apiVersion: z.string(), kind: z.literal("Person"), namespace: z.string().transform(parseResourceNamespace), name: z.string(), uid: z.string() }).strict().optional(),
  attention: z.enum(["immediate", "deferred"]).optional(),
  originRef: z.object({ apiVersion: z.string(), kind: z.string(), namespace: z.string().transform((value) => value === "v1" ? value : parseResourceNamespace(value)), name: z.string(), uid: z.string() }).strict().optional(),
  text: z.string().min(1).max(32_000), timezone: z.string().optional(),
  observation: z.record(z.string(), z.unknown()).optional() }).strict();

export const InputDefinition: ResourceDefinition<InputSpec, InputStatus> = {
  type: INPUT_TYPE,
  schema: { spec: InputSpecSchema, status: z.object({ deliveries: z.array(z.string()).optional(), routing: z.object({
    phase: z.enum(["running", "done", "ignored"]), bootstrap: z.boolean().optional(),
    creation: z.object({ sessionId: z.string(), name: z.string(), uid: z.string().optional() }).strict().optional(), destinations: z.array(z.object({ name: z.string(), uid: z.string() }).strict()).optional(), reason: z.string(),
  }).strict().optional() }).strict() },
  validator: { update(previous, current) { if (!isDeepStrictEqual(previous.spec, current.spec)) throw new Error("Input content is immutable"); } },
  printer: inputPrinter,
  retention: { releasedAt: (r) => ["done", "ignored"].includes((r.status as InputStatus).routing?.phase ?? "") ? r.metadata.creationTimestamp : undefined, references: () => [] },
};
