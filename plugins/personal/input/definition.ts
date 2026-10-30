import { validateReviewRequest } from "../topic/review.ts";
import { PersonRefSchema } from "../person/model.ts";
import { ConditionsSchema } from "../conditions.ts";
import { AgentStatusSchema } from "../session.ts";
import { AgentCallSchema } from "../observation/reference.ts";
import { WorkInputRequestSchema } from "../model.ts";
import { ResourceRefSchema, OrganizationSchema } from "../topic/ref.ts";
import { guardAssessment } from "./assignment.ts";
import { guardInputTopic } from "../topic/ownership.ts";
import { z } from "zod";
import { isDeepStrictEqual } from "node:util";
import { ResourceVersionConflict, type ResourceDefinition } from "@compforge/aide-plugin";
import { INPUT_TYPE, INPUT_ORIGINS, InputAttention, isInternalInput, inputQueue, type InputSpec, type InputStatus } from "./model.ts";
import { AddressSchema } from "../../../src/address.ts";
import { parseResourceNamespace } from "../../../src/host/plugin/namespace.ts";
import { inputPrinter } from "./printer.ts";
export const InputSpecSchema = z.object({ source: AddressSchema.optional(), topicKey: z.string().min(1).max(500).optional(), topicId: z.string().min(1).optional(), origin: z.enum(INPUT_ORIGINS),
  topicName: z.string().trim().min(1).max(80).optional(),
  originId: z.string().min(1), relation: z.enum(["sent", "received", "observed"]).optional(),
  sender: PersonRefSchema.optional(),
  receivers: z.array(PersonRefSchema).optional(),
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
    assess: assessment.extend({ topic: ResourceRefSchema.optional() }).optional(),
    handle: z.record(z.string(), assessment.extend({ resource: ref, assignedAt: z.string(), appliedAt: z.string().optional(), request: WorkInputRequestSchema })).optional(),
  }).strict() },
  validator: { create(current, context) {
    if (isInternalInput(current.spec) && current.spec.originId === "personal.topic") validateReviewRequest(current, context);
    if (isInternalInput(current.spec) && current.status.topic && !current.status.assess?.completedAt
      && context.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "internalPending", value: JSON.stringify([current.status.topic.uid, current.spec.origin]) } })
        .some(i => i.metadata.uid !== current.metadata.uid)) throw new ResourceVersionConflict("Topic already has this internal Input pending");
  }, update(previous, current, context) {
    if (previous.status.assess?.completedAt && !isDeepStrictEqual({ ...previous.status.assess, topic: undefined }, { ...current.status.assess, topic: undefined })) throw new Error("Input assessment is already completed");
    guardInputTopic(previous, current, context);
    if (previous.status.topic && previous.status.topic.uid !== current.status.topic?.uid
      && current.status.assess && !current.status.assess.executionId && !current.status.assess.completedAt && current.status.assess.topic)
      throw new Error("Moving pending Input requires invalidating processing assignment");
    guardAssessment(previous, current, context);
    if (previous.status.assess?.executionId && current.status.assess?.executionId
      && previous.status.assess.executionId !== current.status.assess.executionId) throw new Error("Input is already admitted to a Chief execution");
    if (!isDeepStrictEqual(previous.spec, current.spec)) throw new Error("Input content is immutable");
    if (previous.status.route?.completedAt && !isDeepStrictEqual(previous.status.route.result, current.status.route?.result)) throw new Error("Input routing receipt is immutable");
  } },
  printer: inputPrinter,
  indexes: {
    topic: r => r.status.topic ? [r.status.topic.uid] : [],
    assignmentPending: r => !r.metadata.deletionTimestamp && r.status.topic && r.status.assess && !r.status.assess.executionId && !r.status.assess.completedAt ? [r.status.topic.uid] : [],
    unassigned: r => !r.metadata.deletionTimestamp && r.status.topic && r.status.assess && !r.status.assess.topic && !r.status.assess.executionId && !r.status.assess.completedAt ? [r.status.topic.uid] : [],
    unfiled: r => !r.metadata.deletionTimestamp && !isInternalInput(r.spec) && !r.spec.topicKey && r.status.topic ? [r.status.topic.uid] : [],
    internalPending: r => !r.metadata.deletionTimestamp && isInternalInput(r.spec) && r.status.topic && !r.status.assess?.completedAt
      ? [JSON.stringify([r.status.topic.uid, r.spec.origin])] : [],
    assignedPending: r => !r.metadata.deletionTimestamp && r.status.assess?.topic && !r.status.assess.completedAt ? [r.status.assess.topic.uid] : [],
    assessReadyAttention: r => !r.metadata.deletionTimestamp && r.status.assess?.topic
      && !r.status.assess.completedAt && !r.status.assess.executionId
      ? [JSON.stringify([r.status.assess.topic.uid, inputQueue(r.spec)])] : [],
    routePending: r => r.status.route?.completedAt ? [] : ["pending"],
    assessPending: r => r.status.assess && !r.status.assess.completedAt ? (r.status.topic ? [r.status.topic.uid] : []) : [],
    assessExecution: r => r.status.assess?.executionId && !r.status.assess.completedAt ? [r.status.assess.executionId] : [],
    handle: r => Object.keys(r.status.handle ?? {}),
    handlePending: r => Object.entries(r.status.handle ?? {}).filter(([, s]) => !s.completedAt).map(([uid]) => uid),
  },
  retention: { releasedAt: r => {
    const completed = [r.status.route?.completedAt, ...(r.status.assess ? [r.status.assess.completedAt] : []), ...Object.values(r.status.handle ?? {}).map(s => s.completedAt)];
    return completed.every(Boolean) ? (completed as string[]).sort().at(-1) : undefined;
  }, references: () => [] },
};
