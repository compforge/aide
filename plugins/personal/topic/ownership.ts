import { isDeepStrictEqual } from "node:util";
import type { Resource, ResourceReader, ResourceRef, ResourceValidationContext } from "@compforge/aide-plugin";
import type { InputSpec, InputStatus } from "../input/model.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "./model.ts";

export async function assignedTopicId(resources: ResourceReader, ref: ResourceRef): Promise<string> {
  const topic = await resources.get<TopicSpec, TopicStatus>(ref);
  if (!topic || topic.metadata.uid !== ref.uid || topic.metadata.deletionTimestamp) throw new Error(`Assigned Topic unavailable: ${ref.uid}`);
  return topic.spec.id;
}
export function requireTopic(ref: ResourceRef | undefined, context: ResourceValidationContext) {
  const topic = ref && context.list<TopicSpec, TopicStatus>(TOPIC_TYPE).find(t => t.metadata.uid === ref.uid && t.metadata.name === ref.name);
  if (!topic || topic.metadata.deletionTimestamp) throw new Error("Assigned Topic unavailable");
  return topic;
}
/** @spec Reassignment changes visibility, never routing history or completed processing receipts.
 * @why An admitted Input finishes before moving, so its active Chief cannot lose authority mid-turn.
 * @link docs/personal/topic.md#归属调整与责任交接
 */
export function guardInputTopic(previous: Resource<InputSpec, InputStatus>, current: Resource<InputSpec, InputStatus>, context: ResourceValidationContext) {
  if (isDeepStrictEqual(previous.status.topic, current.status.topic)) return;
  requireTopic(current.status.topic, context);
  if (previous.status.topic && ((previous.status.assess?.executionId && !previous.status.assess.completedAt)
    || (current.status.assess?.executionId && !current.status.assess.completedAt)))
    throw new Error("Finish Input assessment before moving Topic ownership");
}
