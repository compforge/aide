import type { Resource, ResourceValidationContext } from "@compforge/aide-plugin";
import type { LoopStatus } from "../loop.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "./model.ts";
/** @spec Work cannot be created on a retired root or start during its Weave handoff. */
export function guardWork(current: Resource<{ topicId: string }, LoopStatus>, context: ResourceValidationContext, previous?: Resource<{ topicId: string }, LoopStatus>) {
  const topic = context.list<TopicSpec, TopicStatus>(TOPIC_TYPE).find(t => t.spec.id === current.spec.topicId);
  if (topic?.metadata.deletionTimestamp || topic?.spec.parentRef) throw new Error("Work requires a live root Topic");
  if (topic?.status.weaveLock && (!previous
    || (!previous.status.execution && previous.spec.topicId === current.spec.topicId)
    || (current.status.execution && current.status.execution.id !== previous.status.execution?.id))) throw new Error("Weave has frozen Work admission");
}
