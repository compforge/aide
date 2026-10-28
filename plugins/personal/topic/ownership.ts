import { isDeepStrictEqual } from "node:util";
import type { Resource, ResourceReader, ResourceRef, ResourceValidationContext } from "@compforge/aide-plugin";
import type { InputSpec, InputStatus } from "../input/model.ts";
import type { Organization } from "./ref.ts";
import { TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "./model.ts";

export async function assignedTopicId(resources: ResourceReader, ref: ResourceRef): Promise<string> {
  const topic = await resources.get<TopicSpec, TopicStatus>(ref);
  if (!topic || topic.metadata.uid !== ref.uid || topic.metadata.deletionTimestamp) throw new Error(`Assigned Topic unavailable: ${ref.uid}`);
  return topic.spec.id;
}
export function requireTopic(ref: ResourceRef | undefined, context: ResourceValidationContext) {
  const topic = ref?.uid ? context.get<TopicSpec, TopicStatus>(TOPIC_TYPE, ref.uid) : undefined;
  if (!topic || topic.metadata.name !== ref?.name || topic.metadata.namespace !== ref.namespace
    || ref.apiVersion !== TOPIC_TYPE.apiVersion || ref.kind !== TOPIC_TYPE.kind || topic.metadata.deletionTimestamp) throw new Error("Assigned Topic unavailable");
  return topic;
}
/** @spec Reassignment changes visibility, never routing history or completed processing receipts.
 * @why An admitted Input finishes before moving, so its active Chief cannot lose authority mid-turn.
 * @link docs/personal/topic.md#归属调整与责任交接
 */
export function guardInputTopic(previous: Resource<InputSpec, InputStatus>, current: Resource<InputSpec, InputStatus>, context: ResourceValidationContext) {
  if (isDeepStrictEqual(previous.status.topic, current.status.topic)) return;
  const target = requireTopic(current.status.topic, context);
  if (previous.status.topic) requireOrganization(current.status.organization, context, [requireTopic(previous.status.topic, context), target]);
  if (previous.status.topic && ((previous.status.assess?.executionId && !previous.status.assess.completedAt)
    || (current.status.assess?.executionId && !current.status.assess.completedAt)))
    throw new Error("Finish Input assessment before moving Topic ownership");
}

/** @spec Chief ownership changes validate the current tree and execution inside the storage transaction.
 * @why Unrelated summary changes do not invalidate a move; changed responsibility does, even on an intermediate ancestor.
 * @link docs/personal/topic.md#归属调整与责任交接
 * @case tests/topic-ownership.test.ts
 */
export function requireOrganization(organization: Organization | undefined, context: ResourceValidationContext, topics: readonly TopicResource[]) {
  const actor = organization && context.get<TopicSpec, TopicStatus>(TOPIC_TYPE, organization.actorUid);
  if (!actor || actor.metadata.deletionTimestamp || actor.spec.parentRef || !organization?.executionId
    || actor.status.execution?.id !== organization.executionId) throw new Error("Organization requires the active root Chief");
  for (const topic of topics) {
    let current = topic;
    const seen = new Set<string>();
    while (current.spec.parentRef) {
      if (seen.has(current.metadata.uid)) throw new Error("Topic parent cycle");
      seen.add(current.metadata.uid);
      current = requireTopic(current.spec.parentRef, context);
    }
    if (current.metadata.uid !== actor.metadata.uid) throw new Error("Organization target is outside the current root");
  }
  return actor;
}
