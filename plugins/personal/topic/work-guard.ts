import type { Resource, ResourceValidationContext } from "@compforge/aide-plugin";
import type { LoopStatus } from "../loop.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "./model.ts";
/** @spec Work belongs to a live Topic, independently of its current root and Chief. */
export function guardWork(current: Resource<{ topicId: string }, LoopStatus>, context: ResourceValidationContext, previous?: Resource<{ topicId: string }, LoopStatus>) {
  const topic = context.list<TopicSpec, TopicStatus>(TOPIC_TYPE).find(t => t.spec.id === current.spec.topicId);
  if (topic?.metadata.deletionTimestamp) throw new Error("Work requires a live Topic");
  if (previous && previous.spec.topicId !== current.spec.topicId) throw new Error("Work Topic ownership is immutable");
}
