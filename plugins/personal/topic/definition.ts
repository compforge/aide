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
    if (value.spec.default) throw new Error("Topic parent unavailable");
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
    review: TopicReviewSchema.optional(), topicKey: z.string().min(1).max(500).optional(), parentRef: ResourceRefSchema.optional() }).strict(),
    status: z.object({ conditions: ConditionsSchema, summaryDependencies: z.record(z.string(), z.string()).optional(), organization: OrganizationSchema.optional(), receipts: z.array(z.object({ key: z.string(), responseId: z.string() }).strict()).default([]),
      weaveRevision: z.number().int().nonnegative().optional(),
      notifiedWeaveRevision: z.number().int().nonnegative().optional(), lastError: z.string().nullable().optional(),
      idleReviewReset: z.object({ at: z.string().datetime(), previousCount: z.number().int().nonnegative() }).strict().nullable().optional(),
      lastInputAt: z.string().datetime().optional(), absorbed: z.record(z.string(), z.string()).optional(), absorbedSummaries: z.record(z.string(), z.string()).optional(),
      nextAbsorbAt: z.string().datetime().optional(), absorbAttempts: z.number().int().min(0).max(5).optional(), reviewCheckedAt: z.string().datetime().nullable().optional(), idleReviewCount: z.number().int().nonnegative().optional(), idleSince: z.string().datetime().optional(), agent: AgentStatusSchema.optional(), execution: LoopExecutionSchema.nullable().optional(), ...ContextFields }).strict() },
  validator: { create: (resource, context) => { validateDefault(resource, context); guardTopicOrganization(resource, context); }, update: (previous, current, context) => {
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
    if (context.list<TopicSpec, TopicStatus>(TOPIC_TYPE, { matchIndex: { name: "parent", value: resource.metadata.uid } }).length) throw new TopicDeletionBlocked("children", "Topic still has children");
    const pending = context.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "assessPending", value: resource.metadata.uid } }).length;
    if (pending) throw new TopicDeletionBlocked("busy", "Topic has pending Input");
    if (WORK_TYPES.some(type => context.list<WorkResource["spec"], WorkResource["status"]>(type, { matchIndex: { name: "topic", value: resource.metadata.uid } }).length)) throw new TopicDeletionBlocked("work", "Topic still owns Work");
    if (resource.spec.parentRef) {
      const parent = context.get<TopicSpec, TopicStatus>(TOPIC_TYPE, resource.spec.parentRef.uid);
      if (!parent || parent.status.absorbed?.[resource.metadata.uid] !== understandingVersion(resource)) throw new TopicDeletionBlocked("unabsorbed", "Parent must absorb Topic understanding before deletion");
    }
  } },
  indexes: { default: r => r.spec.default && !r.metadata.deletionTimestamp ? ["default"] : [],
    topicKey: r => r.metadata.deletionTimestamp || !r.spec.topicKey ? [] : [r.spec.topicKey],
    parent: r => r.spec.parentRef ? [r.spec.parentRef.uid] : [], root: r => !r.metadata.deletionTimestamp && !r.spec.parentRef ? ["root"] : [] },
  retention: { releasedAt: () => undefined, references: () => {
    return [];
  } },
};
