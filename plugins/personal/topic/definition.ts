import { PersonRefSchema } from "../person/model.ts";
import { validateSummary } from "../note/summary.ts";
import { candidateVersion } from "../weave/candidates.ts";
import { NoteWriterSchema } from "../note/model.ts";
import { canReclaimTopic, reclamationVersion } from "./retention.ts";
import { isDeepStrictEqual } from "node:util";
import { notes } from "../note/query.ts";
import { requireContentWriter } from "../context-write.ts";
import { guardContext } from "../context-write.ts";
import { guardTopicOrganization } from "./organization.ts";
import { requireTopic } from "./ownership.ts";
import { ConditionsSchema } from "../conditions.ts";
import { OrganizationSchema } from "../topic/ref.ts";
import { digest } from "../chief-model.ts";
import { AgentStatusSchema } from "../session.ts";
import { ContextFields } from "../context.ts";
import { z } from "zod";
import { TopicReviewSchema } from "./review.ts";
import type { ResourceDefinition, ResourceValidationContext } from "@compforge/aide-plugin";
import { AddressSchema } from "../../../src/address.ts";
import { TOPIC_TYPE, TopicDeletionBlocked, DEFAULT_TOPIC_ID, type TopicStatus, type TopicSpec, type TopicResource } from "./model.ts";
import { LoopExecutionSchema } from "../loop.ts";
import { ResourceRefSchema } from "../topic/ref.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { WORK_TYPES, type WorkResource } from "../resources.ts";
import { understandingVersion } from "./tree.ts";
/** @spec Default is a system-owned singleton; ordinary Topics cannot adopt or relinquish that role.
 * @why Only creation checks the singleton index; updates preserve the reserved immutable identity.
 * @case tests/resource-validation-scope.test.ts
 * @link docs/personal/topic.md#默认主题
 */
function validateDefault(resource: Readonly<TopicResource>, context: ResourceValidationContext, previous?: Readonly<TopicResource>) {
  const systemDefault = !!resource.spec.default;
  if (systemDefault !== (resource.spec.id === DEFAULT_TOPIC_ID) || systemDefault !== (resource.metadata.name === digest(DEFAULT_TOPIC_ID)))
    throw new Error("Default Topic identity is reserved for the system");
  if (systemDefault && (resource.spec.address || resource.spec.topicKey)) throw new Error("Default Topic cannot have a source address or key");
  if (resource.spec.default && resource.spec.parentRef) throw new Error("Default Topic must remain a root");
  if (resource.spec.topicKey && !resource.metadata.deletionTimestamp && context.list<TopicSpec, TopicStatus>(TOPIC_TYPE, { matchIndex: { name: "topicKey", value: resource.spec.topicKey } }).some(c => c.metadata.uid !== resource.metadata.uid && !c.metadata.deletionTimestamp && c.spec.topicKey === resource.spec.topicKey))
    throw new Error("Topic key already exists");
  const visited = new Set([resource.metadata.uid]);
  let parent = resource.spec.parentRef;
  while (parent) {
    if (visited.has(parent.uid)) throw new Error("Topic parent cycle");
    visited.add(parent.uid);
    const value = requireTopic(parent, context);
    parent = value.spec.parentRef;
  }
  // Default identity cannot change after creation; status writes need no uniqueness lookup.
  if (!previous && resource.spec.default && !resource.metadata.deletionTimestamp && context.list<TopicSpec, TopicStatus>(TOPIC_TYPE,
    { matchIndex: { name: "default", value: "default" } })
    .some(c => c.spec.default && !c.metadata.deletionTimestamp && c.metadata.uid !== resource.metadata.uid)) {
    throw new Error("Default Topic already exists");
  }
}
export const TopicDefinition: ResourceDefinition<TopicSpec, TopicStatus> = {
  type: TOPIC_TYPE,
  schema: { spec: z.object({ id: z.string(), address: AddressSchema.optional(), name: z.string().optional(), default: z.boolean().optional(),
    people: z.array(PersonRefSchema).max(1000).optional(), review: TopicReviewSchema.optional(), topicKey: z.string().min(1).max(500).optional(), parentRef: ResourceRefSchema.optional() }).strict(),
    status: z.object({ conditions: ConditionsSchema, summaryDependencies: z.record(z.string(), z.string()).optional(), organization: OrganizationSchema.optional(), receipts: z.array(z.object({ key: z.string(), responseId: z.string() }).strict()).default([]),
      weaveReview: z.object({ version: z.string(), at: z.string().datetime() }).strict().optional(),
      weaveRevision: z.number().int().nonnegative().optional(),
      notifiedWeaveRevision: z.number().int().nonnegative().optional(), lastError: z.string().nullable().optional(),
      capacityRequests: z.partialRecord(z.enum(["aide:triage", "aide:organize"]), z.object({ checkedAt: z.string().datetime(), inputId: z.string() }).strict()).optional(),
      noteReviewQueue: z.array(z.object({ noteId: z.string(), version: z.string() }).strict()).max(20).optional(),
      reclamation: z.object({ version: z.string(), reason: z.string().trim().min(1), writer: NoteWriterSchema }).strict().optional(),
      assignmentRefresh: z.object({ version: z.string(), cursor: z.string(), complete: z.boolean() }).strict().optional(),
      yieldToInput: z.boolean().optional(),
      idleReviewReset: z.object({ at: z.string().datetime(), previousCount: z.number().int().nonnegative() }).strict().nullable().optional(),
      lastInputAt: z.string().datetime().optional(), absorbed: z.record(z.string(), z.string()).default({}), absorbedSummaries: z.record(z.string(), z.string()).default({}),
      nextAbsorbAt: z.string().datetime().optional(), absorbAttempts: z.number().int().min(0).max(5).optional(), reviewCheckedAt: z.string().datetime().nullable().optional(), idleReviewCount: z.number().int().nonnegative().optional(), idleSince: z.string().datetime().optional(), agent: AgentStatusSchema.optional(), execution: LoopExecutionSchema.nullable().optional(), ...ContextFields }).strict() },
  validator: { create: (resource, context) => { validateSummary(resource, context); validateDefault(resource, context); guardTopicOrganization(resource, context); }, update: (previous, current, context) => {
    guardContext(previous, current, context);
    if (current.status.reclamation && !isDeepStrictEqual(previous.status.reclamation, current.status.reclamation)) {
      requireContentWriter(current, current.status.reclamation.writer, context);
      if (current.status.reclamation.version !== reclamationVersion(current, context))
        throw new Error("Topic understanding changed before release");
    }
    const reviewed = current.status.organization?.reviewedVersion;
    if (reviewed && JSON.stringify(previous.status.organization) !== JSON.stringify(current.status.organization)
      && understandingVersion(previous, notes(context, previous.metadata.uid, "subject")) !== reviewed)
      throw new Error("Topic understanding changed before organization");
    if (JSON.stringify(previous.status.absorbed) !== JSON.stringify(current.status.absorbed)) {
      if (current.status.contextWriter) requireContentWriter(current, current.status.contextWriter, context);
      for (const [uid, version] of Object.entries(current.status.absorbed ?? {})) {
        if (previous.status.absorbed?.[uid] === version) continue;
        const child = context.get<TopicSpec, TopicStatus>(TOPIC_TYPE, uid);
        if (!child || child.metadata.deletionTimestamp || child.spec.parentRef?.uid !== current.metadata.uid || understandingVersion(child, notes(context, uid, "subject")) !== version)
          throw new Error("Child understanding changed; read and review again");
      }
    }
    if (previous.spec.id !== current.spec.id || previous.spec.topicKey !== current.spec.topicKey) throw new Error("Topic identity is immutable");
    if (current.spec.parentRef && current.status.execution && current.status.execution.id !== previous.status.execution?.id)
      throw new Error("Only a root Topic can start Chief");
    validateDefault(current, context, previous);
    guardTopicOrganization(current, context, previous);
  }, delete: (resource, context) => {
    // @spec Deletion checks current indexed dependents in the write transaction, including preceding writes.
    // @case tests/resource-validation-scope.test.ts
    // @link docs/personal/topic.md#静默回收
    if (resource.spec.default) throw new TopicDeletionBlocked("default", "Default Topic cannot be deleted");
    if (resource.status.execution) throw new TopicDeletionBlocked("busy", "Topic is busy");
    if (context.page(TOPIC_TYPE, { limit: 1, matchIndex: { name: "parent", value: resource.metadata.uid } }).items.length) throw new TopicDeletionBlocked("children", "Topic still has children");
    const pending = context.page(INPUT_TYPE, { limit: 1, matchIndex: { name: "assessPending", value: resource.metadata.uid } }).items.length;
    if (pending) throw new TopicDeletionBlocked("busy", "Topic has pending Input");
    if (WORK_TYPES.some(type => context.page(type, { limit: 1, matchIndex: { name: "topic", value: resource.metadata.uid } }).items.length)) throw new TopicDeletionBlocked("work", "Topic still owns Work");
    if (resource.spec.parentRef) {
      const parent = context.get<TopicSpec, TopicStatus>(TOPIC_TYPE, resource.spec.parentRef.uid);
      if (!parent || parent.status.absorbed?.[resource.metadata.uid] !== understandingVersion(resource, notes(context, resource.metadata.uid, "subject"))) throw new TopicDeletionBlocked("unabsorbed", "Parent must absorb Topic understanding before deletion");
    }
  } },
  indexes: { uid: r => [r.metadata.uid], default: r => r.spec.default && !r.metadata.deletionTimestamp ? ["default"] : [],
    topicKey: r => r.metadata.deletionTimestamp || !r.spec.topicKey ? [] : [r.spec.topicKey],
    liveParent: r => !r.metadata.deletionTimestamp && r.spec.parentRef ? [r.spec.parentRef.uid] : [],
    parent: r => r.spec.parentRef ? [r.spec.parentRef.uid] : [], weaveRoot: r => !r.metadata.deletionTimestamp && !r.spec.parentRef && !r.spec.default ? ["root"] : [], root: r => !r.metadata.deletionTimestamp && !r.spec.parentRef ? ["root"] : [] },
  orderedIndexes: {
    weavePending: r => !r.metadata.deletionTimestamp && !r.spec.parentRef && !r.spec.default && r.status.weaveReview?.version !== candidateVersion(r)
      ? [{ value: "root", order: r.status.weaveReview?.at ?? "" }] : [],
    weaveReviewed: r => !r.metadata.deletionTimestamp && !r.spec.parentRef && !r.spec.default && r.status.weaveReview?.version === candidateVersion(r)
      ? [{ value: "root", order: r.status.weaveReview.at }] : [],
  },
  retention: { releasedAt: r => !r.spec.default && !r.status.execution && !r.status.agent?.sessionId
    ? r.status.lastInputAt ?? r.metadata.creationTimestamp : undefined,
    canEvict: canReclaimTopic, references: () => [] },
};
