import { WorkInputRequestSchema } from "../model.ts";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { type ResourceDefinition } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "./model.ts";
import { AddressSchema } from "../../../src/address.ts";
import { parseResourceNamespace } from "../../../src/host/plugin/namespace.ts";
import { inputPrinter } from "./printer.ts";
export const InputSpecSchema = z.object({ source: AddressSchema.optional(), sessionId: z.string().min(1).max(200).optional(), origin: z.enum(["channel", "source", "chief"]),
  originId: z.string().min(1), relation: z.enum(["sent", "received", "observed"]).optional(),
  sender: z.object({ apiVersion: z.string(), kind: z.literal("Person"), namespace: z.string().transform(parseResourceNamespace), name: z.string(), uid: z.string() }).strict().optional(),
  attention: z.enum(["immediate", "deferred"]).optional(),
  originRef: z.object({ apiVersion: z.string(), kind: z.string(), namespace: z.string().transform((value) => value === "v1" ? value : parseResourceNamespace(value)), name: z.string(), uid: z.string() }).strict().optional(),
  text: z.string().min(1).max(32_000), timezone: z.string().optional(),
  observation: z.record(z.string(), z.unknown()).optional() }).strict();

const ref = z.object({ apiVersion: z.string(), kind: z.string(), namespace: z.string().transform(parseResourceNamespace), name: z.string(), uid: z.string() }).strict();
const attempt = z.object({ executionId: z.string().optional(), startedAt: z.string().optional(), completedAt: z.string().optional(), lastError: z.string().optional() }).strict();
const assessment = attempt.extend({ resource: ref, assignedAt: z.string(), result: z.object({ summary: z.string(), disposition: z.enum(["completed", "cancelled", "rejected"]).optional() }).strict().optional() });
export const InputDefinition: ResourceDefinition<InputSpec, InputStatus> = {
  type: INPUT_TYPE,
  schema: { spec: InputSpecSchema, status: z.object({
    route: attempt.extend({ nextAttemptAt: z.string().optional(), attempts: z.number().int().nonnegative().optional(),
      result: z.object({ conversations: z.array(ref), reason: z.string() }).strict().optional() }).optional(),
    assess: z.record(z.string(), assessment).optional(),
    handle: z.record(z.string(), assessment.extend({ appliedAt: z.string().optional(), request: WorkInputRequestSchema })).optional(),
  }).strict() },
  validator: { update(previous, current) { if (!isDeepStrictEqual(previous.spec, current.spec)) throw new Error("Input content is immutable"); } },
  printer: inputPrinter,
  indexes: {
    routePending: r => r.status.route?.completedAt ? [] : ["pending"],
    assess: r => Object.keys(r.status.assess ?? {}),
    assessPending: r => Object.entries(r.status.assess ?? {}).filter(([, s]) => !s.completedAt).map(([uid]) => uid),
    handle: r => Object.keys(r.status.handle ?? {}),
    handlePending: r => Object.entries(r.status.handle ?? {}).filter(([, s]) => !s.completedAt).map(([uid]) => uid),
  },
  retention: { releasedAt: r => {
    const completed = [r.status.route?.completedAt, ...Object.values(r.status.assess ?? {}).map(s => s.completedAt), ...Object.values(r.status.handle ?? {}).map(s => s.completedAt)];
    return completed.every(Boolean) ? (completed as string[]).sort().at(-1) : undefined;
  }, references: () => [] },
};
