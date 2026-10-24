import { WEAVE_TYPE, type WeaveStatus } from "../weave/model.ts";
import { AgentStatusSchema } from "../session.ts";
import { ContextFields } from "../context.ts";
import { z } from "zod";
import { TopicTriggerSchema } from "./trigger.ts";
import type { ResourceDefinition, ResourceValidationContext } from "@compforge/aide-plugin";
import { AddressSchema } from "../../../src/address.ts";
import { TOPIC_TYPE, TopicDeletionBlocked, TopicDefaultBlocked, type TopicStatus, type TopicSpec, type TopicResource } from "./model.ts";
import { LoopExecutionSchema } from "../loop.ts";
import { ResourceRefSchema } from "../topic/ref.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { WORK_TYPES, type WorkResource } from "../resources.ts";
import { topicPath, understandingVersion } from "./tree.ts";
/** @spec User selection and Route fallback cannot establish two live Default topics. */
function validateDefault(resource: Readonly<TopicResource>, context: ResourceValidationContext) {
  const all = context.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
  if (resource.spec.default && resource.spec.parentRef) throw new Error("Default Topic must remain a root");
  if (resource.spec.topicKey && !resource.metadata.deletionTimestamp && all.some(c => c.metadata.uid !== resource.metadata.uid && !c.metadata.deletionTimestamp && c.spec.topicKey === resource.spec.topicKey))
    throw new Error("Topic key already exists");
  const visited = new Set([resource.metadata.uid]);
  let parent = resource.spec.parentRef;
  while (parent) {
    if (visited.has(parent.uid)) throw new Error("Topic parent cycle");
    visited.add(parent.uid);
    const value = all.find(t => t.metadata.uid === parent!.uid && t.metadata.name === parent!.name);
    if (!value || value.metadata.deletionTimestamp || value.spec.default) throw new Error("Topic parent unavailable");
    parent = value.spec.parentRef;
  }
  if (resource.spec.default && !resource.metadata.deletionTimestamp && context.list<TopicSpec, TopicStatus>(TOPIC_TYPE)
    .some(c => c.spec.default && !c.metadata.deletionTimestamp && c.metadata.uid !== resource.metadata.uid)) {
    throw new Error("Default Topic already exists");
  }
}
export const TopicDefinition: ResourceDefinition<TopicSpec, TopicStatus> = {
  type: TOPIC_TYPE,
  schema: { spec: z.object({ id: z.string(), address: AddressSchema.optional(), name: z.string().optional(), default: z.boolean().optional(),
    trigger: TopicTriggerSchema.optional(), topicKey: z.string().min(1).max(500).optional(), parentRef: ResourceRefSchema.optional() }).strict(),
    status: z.object({  receipts: z.array(z.object({ key: z.string(), responseId: z.string() }).strict()).default([]),
      lastInputAt: z.string().datetime().optional(), weaveLock: z.string().nullable().optional(), absorbed: z.record(z.string(), z.string()).optional(),
      nextTriggerAt: z.string().nullable().optional(), agent: AgentStatusSchema.optional(), execution: LoopExecutionSchema.nullable().optional(), ...ContextFields }).strict() },
  validator: { create: validateDefault, update: (previous, current, context) => {
    // @spec Selecting a grouped leaf as Default detaches it only after its previous processing scope is quiet.
    // @link docs/personal/topic.md#默认主题
    if (current.spec.default && !previous.spec.default) {
      const all = context.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
      if (all.some(t => t.spec.parentRef?.uid === current.metadata.uid)) throw new TopicDefaultBlocked("Default Topic cannot have children; select a leaf Topic");
      if (previous.status.weaveLock || current.status.weaveLock) throw new TopicDefaultBlocked("Topic is being organized; retry after Weave completes");
      if (previous.spec.parentRef) {
        if (topicPath(all, previous).some(t => t.status.execution || t.status.weaveLock)) throw new TopicDefaultBlocked("Topic processing is active; retry after it completes");
        if (context.list<InputSpec, InputStatus>(INPUT_TYPE).some(i =>
          (i.status.route?.result?.topics.some(t => t.uid === previous.metadata.uid) || i.status.assess?.[previous.metadata.uid])
          && Object.values(i.status.assess ?? {}).some(a => !a.completedAt))) throw new TopicDefaultBlocked("Topic has pending Input; retry after assessment completes");
      }
    }
    if (previous.spec.id !== current.spec.id || previous.spec.topicKey !== current.spec.topicKey) throw new Error("Topic identity is immutable");
    if (current.spec.parentRef && current.status.execution) throw new Error("Only a root Topic can execute");
    if (current.status.weaveLock && current.status.execution?.id !== previous.status.execution?.id && current.status.execution) throw new Error("Weave has frozen Topic intake");
    if (previous.status.weaveLock && !previous.status.execution && understandingVersion(current) !== understandingVersion(previous)) throw new Error("Weave has frozen Topic understanding");
    validateDefault(current, context);
  }, delete: (resource, context) => {
    if (resource.spec.default) throw new TopicDeletionBlocked("default", "Default Topic cannot be deleted");
    const staged = context.list<Record<string, never>, WeaveStatus>(WEAVE_TYPE).some(w => w.status.plan?.id === resource.spec.id && !w.status.plan.moving);
    if (resource.status.execution || (resource.status.weaveLock && !staged)) throw new TopicDeletionBlocked("busy", "Topic is busy");
    if (context.list<TopicSpec, TopicStatus>(TOPIC_TYPE).some(t => t.spec.parentRef?.uid === resource.metadata.uid)) throw new TopicDeletionBlocked("children", "Topic still has children");
    const pending = context.list<InputSpec, InputStatus>(INPUT_TYPE).some(i =>
      (i.status.route?.result?.topics.some(t => t.uid === resource.metadata.uid) || i.status.assess?.[resource.metadata.uid])
      && Object.values(i.status.assess ?? {}).some(a => !a.completedAt));
    if (pending) throw new TopicDeletionBlocked("busy", "Topic has pending Input");
    if (WORK_TYPES.some(type => context.list<WorkResource["spec"], WorkResource["status"]>(type).some(w => w.spec.topicId === resource.spec.id))) throw new TopicDeletionBlocked("work", "Topic still owns Work");
    if (resource.spec.parentRef) {
      const parent = context.list<TopicSpec, TopicStatus>(TOPIC_TYPE).find(t => t.metadata.uid === resource.spec.parentRef!.uid);
      if (!parent || parent.status.absorbed?.[resource.metadata.uid] !== understandingVersion(resource)) throw new TopicDeletionBlocked("unabsorbed", "Parent must absorb Topic understanding before deletion");
    }
  } },
  indexes: { topicKey: r => r.metadata.deletionTimestamp || !r.spec.topicKey ? [] : [r.spec.topicKey],
    parent: r => r.spec.parentRef ? [r.spec.parentRef.uid] : [], root: r => !r.metadata.deletionTimestamp && !r.spec.parentRef ? ["root"] : [] },
  retention: { releasedAt: () => undefined, references: () => {
    return [];
  } },
};
