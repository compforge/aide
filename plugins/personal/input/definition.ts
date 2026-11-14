import { InputPolicySchema } from "./config.ts";
import { inputExpiry, inputHardExpiry, inputPressure } from "./retention.ts";
import { InputClassificationFields } from "../disclosure.ts";
import { channelPromotion } from "./identity.ts";
import { obsoleteReplies, replyIdentity } from "../address/reply.ts";
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
import { equalResourceValue } from "../../../src/resource/value.ts";
import { ResourceVersionConflict, type ResourceDefinition } from "@compforge/aide-plugin";
import { assessmentFinished, INPUT_TYPE, INPUT_ORIGINS, InputAttention, isInternalInput, inputQueue, type InputSpec, type InputStatus } from "./model.ts";
import { AddressRefSchema } from "../address/model.ts";
import { parseResourceNamespace } from "../../../src/host/plugin/namespace.ts";
import { inputPrinter } from "./printer.ts";
import { EvidenceRefSchema } from "../handoff/model.ts";
export const InputSpecSchema = z.object({ ...InputClassificationFields, inputKey: z.string().min(1).max(2000).optional(), source: AddressRefSchema.optional(), replyToMessageId: z.string().optional(), topicKey: z.string().min(1).max(500).optional(), topicId: z.string().min(1).optional(), origin: z.enum(INPUT_ORIGINS),
  handoff: z.object({ id: z.string().min(1), gate: ResourceRefSchema, sourceInput: EvidenceRefSchema, replyTo: AddressRefSchema }).strict().optional(),
  topicName: z.string().trim().min(1).max(80).optional(),
  originId: z.string().min(1), relation: z.enum(["sent", "received", "observed"]).optional(),
  sender: PersonRefSchema.optional(),
  attention: z.enum(InputAttention).optional(),
  originRef: z.object({ apiVersion: z.string(), kind: z.string(), namespace: z.string().transform((value) => value === "v1" ? value : parseResourceNamespace(value)), name: z.string(), uid: z.string() }).strict().optional(),
  text: z.string().min(1).max(32_000), timezone: z.string().optional(),
  observation: z.record(z.string(), z.unknown()).optional() }).strict();

const ref = z.object({ apiVersion: z.string(), kind: z.string(), namespace: z.string().transform(parseResourceNamespace), name: z.string(), uid: z.string() }).strict();
const attempt = z.object({ agent: AgentStatusSchema.optional(), completedBy: AgentCallSchema.optional(), executionId: z.string().optional(), deliveryId: z.string().optional(), startedAt: z.string().optional(), completedAt: z.string().optional(), lastError: z.string().optional(), errorAt: z.iso.datetime().optional(), retryable: z.boolean().optional() }).strict();
const assessment = attempt.extend({ result: z.object({ summary: z.string(), disposition: z.enum(["completed", "cancelled", "rejected"]).optional() }).strict().optional() });
/**
 * @spec Internal request deduplication covers queued and running assessments, excluding recorded failures.
 * @why A failed assessment keeps its admission receipt without blocking a later independent maintenance Input.
 * @link docs/personal/topic.md#树内整理与维护优先级
 * @case tests/topic-review.test.ts
 */
export const InputDefinition: ResourceDefinition<InputSpec, InputStatus> = {
  type: INPUT_TYPE,
  schema: { spec: InputSpecSchema, status: z.object({
    retention: InputPolicySchema.shape.retention.optional(), conditions: ConditionsSchema, topic: ResourceRefSchema.optional(), organization: OrganizationSchema.optional(),
    route: attempt.extend({ nextAttemptAt: z.string().optional(), attempts: z.number().int().nonnegative().optional(),
      result: z.object({ topics: z.array(ref), reason: z.string() }).strict().optional() }).optional(),
    assess: assessment.extend({ topic: ResourceRefSchema.optional() }).optional(),
    handle: z.record(z.string(), assessment.extend({ resource: ref, assignedAt: z.string(), appliedAt: z.string().optional(), request: WorkInputRequestSchema })).optional(),
  }).strict() },
  validator: { create(current, context) {
    if (isInternalInput(current.spec) && current.spec.originId === "personal.topic") validateReviewRequest(current, context);
    if (isInternalInput(current.spec) && current.status.topic && !assessmentFinished(current.status.assess)
      && context.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "internalPending", value: JSON.stringify([current.status.topic.uid, current.spec.origin]) } })
        .some(i => i.metadata.uid !== current.metadata.uid)) throw new ResourceVersionConflict("Topic already has this internal Input pending");
  }, update(previous, current, context) {
    if (assessmentFinished(previous.status.assess) && !equalResourceValue({ ...previous.status.assess, topic: undefined }, { ...current.status.assess, topic: undefined })) throw new Error(previous.status.assess?.lastError ? "Input assessment has failed; submit a new Input" : "Input assessment is already completed");
    if (previous.status.assess?.lastError && !previous.status.assess.completedAt
      && Object.keys(current.status.handle ?? {}).some(uid => !previous.status.handle?.[uid]))
      throw new Error("Failed Input cannot be assigned to new Work");
    guardInputTopic(previous, current, context);
    if (previous.status.topic && previous.status.topic.uid !== current.status.topic?.uid
      && current.status.assess && !current.status.assess.executionId && !current.status.assess.completedAt && current.status.assess.topic)
      throw new Error("Moving pending Input requires invalidating processing assignment");
    guardAssessment(previous, current, context);
    if (previous.status.assess?.executionId && current.status.assess?.executionId
      && previous.status.assess.executionId !== current.status.assess.executionId) throw new Error("Input is already admitted to a Chief execution");
    if (!equalResourceValue(previous.spec, current.spec) && !(channelPromotion(previous.spec, current.spec) && equalResourceValue(previous.status, current.status))) throw new Error("Input content is immutable except Channel promotion of the same platform message");
    if (previous.status.route?.completedAt && !equalResourceValue(previous.status.route.result, current.status.route?.result)) throw new Error("Input routing receipt is immutable");
  } },
  printer: inputPrinter,
  indexes: {
    obsoleteReply: r => obsoleteReplies(r.spec),
    message: r => { const identity = replyIdentity(r); return identity ? [identity.key] : []; },
    address: r => r.spec.source ? [r.spec.source.uid] : [],
    assessActive: r => r.status.topic && r.status.assess?.executionId && !assessmentFinished(r.status.assess) ? [r.status.topic.uid] : [],
    topic: r => r.status.topic ? [r.status.topic.uid] : [],
    assignmentPending: r => !r.metadata.deletionTimestamp && r.status.topic && r.status.assess && !r.status.assess.executionId && !assessmentFinished(r.status.assess) ? [r.status.topic.uid] : [],
    unassigned: r => !r.metadata.deletionTimestamp && r.status.topic && r.status.assess && !r.status.assess.topic && !r.status.assess.executionId && !assessmentFinished(r.status.assess) ? [r.status.topic.uid] : [],
    unfiled: r => !r.metadata.deletionTimestamp && !isInternalInput(r.spec) && !r.spec.topicKey && r.status.topic ? [r.status.topic.uid] : [],
    internalPending: r => !r.metadata.deletionTimestamp && isInternalInput(r.spec) && r.status.topic && !assessmentFinished(r.status.assess)
      ? [JSON.stringify([r.status.topic.uid, r.spec.origin])] : [],
    assignedPending: r => !r.metadata.deletionTimestamp && r.status.assess?.topic && !assessmentFinished(r.status.assess) ? [r.status.assess.topic.uid] : [],
    assessReadyAttention: r => !r.metadata.deletionTimestamp && r.status.assess?.topic
      && !assessmentFinished(r.status.assess) && !r.status.assess.executionId
      ? [JSON.stringify([r.status.assess.topic.uid, inputQueue(r.spec)])] : [],
    routePending: r => r.metadata.deletionTimestamp || r.status.route?.completedAt ? [] : ["pending"],
    assessPending: r => !r.metadata.deletionTimestamp && r.status.assess && !assessmentFinished(r.status.assess) ? (r.status.topic ? [r.status.topic.uid] : []) : [],
    assessDeferredExecution: r => !r.metadata.deletionTimestamp && r.spec.attention === InputAttention.Deferred
      && r.status.assess?.executionId && !assessmentFinished(r.status.assess) ? [r.status.assess.executionId] : [],
    assessExecution: r => !r.metadata.deletionTimestamp && r.status.assess?.executionId && !assessmentFinished(r.status.assess) ? [r.status.assess.executionId] : [],
    handle: r => Object.keys(r.status.handle ?? {}),
    handlePending: r => r.metadata.deletionTimestamp ? [] : Object.entries(r.status.handle ?? {}).filter(([, s]) => !s.completedAt).map(([uid]) => uid),
  },
  orderedIndexes: {
    assessReadyArrival: r => !r.metadata.deletionTimestamp && r.status.assess?.topic
      && !assessmentFinished(r.status.assess) && !r.status.assess.executionId
      ? [{ value: JSON.stringify([r.status.assess.topic.uid, inputQueue(r.spec)]), order: r.metadata.creationTimestamp }] : [],
    topicActivity: r => !r.metadata.deletionTimestamp && r.status.topic
    ? [{ value: r.status.topic.uid, order: r.metadata.creationTimestamp }] : [] },
  retention: { collectOnRelease: true, expiresAt: inputHardExpiry, pressure: inputPressure,
    releasedAt: r => r.status.retention ? inputExpiry(r.status, r.status.retention) : undefined, references: () => [] },
};
