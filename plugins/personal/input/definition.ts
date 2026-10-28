import { ConditionsSchema } from "../conditions.ts";
import { AgentStatusSchema } from "../session.ts";
import { AgentCallSchema } from "../observation/reference.ts";
import { WorkInputRequestSchema } from "../model.ts";
import { ResourceRefSchema, OrganizationSchema } from "../topic/ref.ts";
import { guardInputTopic } from "../topic/ownership.ts";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { type ResourceDefinition } from "@compforge/aide-plugin";
import { INPUT_TYPE, InputAttention, type InputSpec, type InputStatus } from "./model.ts";
import { AddressSchema } from "../../../src/address.ts";
import { parseResourceNamespace } from "../../../src/host/plugin/namespace.ts";
import { inputPrinter } from "./printer.ts";
export const InputSpecSchema = z.object({ source: AddressSchema.optional(), topicKey: z.string().min(1).max(500).optional(), topicId: z.string().min(1).optional(), origin: z.enum(["channel", "source", "chief", "trigger"]),
  topicName: z.string().trim().min(1).max(80).optional(),
  originId: z.string().min(1), relation: z.enum(["sent", "received", "observed"]).optional(),
  sender: z.object({ apiVersion: z.string(), kind: z.literal("Person"), namespace: z.string().transform(parseResourceNamespace), name: z.string(), uid: z.string() }).strict().optional(),
  attention: z.enum(InputAttention).optional(),
  originRef: z.object({ apiVersion: z.string(), kind: z.string(), namespace: z.string().transform((value) => value === "v1" ? value : parseResourceNamespace(value)), name: z.string(), uid: z.string() }).strict().optional(),
  text: z.string().min(1).max(32_000), timezone: z.string().optional(),
  observation: z.record(z.string(), z.unknown()).optional() }).strict();

const ref = z.object({ apiVersion: z.string(), kind: z.string(), namespace: z.string().transform(parseResourceNamespace), name: z.string(), uid: z.string() }).strict();
const attempt = z.object({ agent: AgentStatusSchema.optional(), completedBy: AgentCallSchema.optional(), executionId: z.string().optional(), startedAt: z.string().optional(), completedAt: z.string().optional(), lastError: z.string().optional() }).strict();
const assessment = attempt.extend({ result: z.object({ summary: z.string(), disposition: z.enum(["completed", "cancelled", "rejected"]).optional() }).strict().optional() });
export const InputDefinition: ResourceDefinition<InputSpec, InputStatus> = {
  type: INPUT_TYPE,
  schema: { spec: InputSpecSchema, status: z.object({
    conditions: ConditionsSchema, topic: ResourceRefSchema.optional(), organization: OrganizationSchema.optional(),
    route: attempt.extend({ nextAttemptAt: z.string().optional(), attempts: z.number().int().nonnegative().optional(),
      result: z.object({ topics: z.array(ref), reason: z.string() }).strict().optional() }).optional(),
    assess: assessment.optional(),
    handle: z.record(z.string(), assessment.extend({ resource: ref, assignedAt: z.string(), appliedAt: z.string().optional(), request: WorkInputRequestSchema })).optional(),
  }).strict() },
  validator: { update(previous, current, context) {
    guardInputTopic(previous, current, context);
    if (previous.status.assess?.executionId && current.status.assess?.executionId
      && previous.status.assess.executionId !== current.status.assess.executionId) throw new Error("Input is already admitted to a Chief execution");
    if (previous.status.assess?.completedAt && !isDeepStrictEqual(previous.status.assess, current.status.assess)) throw new Error("Input assessment is already completed");
    if (!isDeepStrictEqual(previous.spec, current.spec)) throw new Error("Input content is immutable");
    if (previous.status.route?.completedAt && !isDeepStrictEqual(previous.status.route.result, current.status.route?.result)) throw new Error("Input routing receipt is immutable");
  } },
  printer: inputPrinter,
  indexes: {
    topic: r => r.status.topic ? [r.status.topic.uid] : [],
    routePending: r => r.status.route?.completedAt ? [] : ["pending"],
    assessPending: r => r.status.assess && !r.status.assess.completedAt ? (r.status.topic ? [r.status.topic.uid] : []) : [],
    assessReady: r => r.status.assess && !r.status.assess.completedAt && !r.status.assess.executionId ? (r.status.topic ? [r.status.topic.uid] : []) : [],
    assessExecution: r => r.status.assess?.executionId && !r.status.assess.completedAt ? [r.status.assess.executionId] : [],
    handle: r => Object.keys(r.status.handle ?? {}),
    handlePending: r => Object.entries(r.status.handle ?? {}).filter(([, s]) => !s.completedAt).map(([uid]) => uid),
  },
  retention: { releasedAt: r => {
    const completed = [r.status.route?.completedAt, ...(r.status.assess ? [r.status.assess.completedAt] : []), ...Object.values(r.status.handle ?? {}).map(s => s.completedAt)];
    return completed.every(Boolean) ? (completed as string[]).sort().at(-1) : undefined;
  }, references: () => [] },
};
