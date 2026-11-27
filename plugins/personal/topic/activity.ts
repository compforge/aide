import type { ResourceValidationContext } from "@compforge/aide-plugin";
import { BATCH_TYPE } from "../batch/model.ts";
import { INPUT_TYPE, InputAttention, inputAttention, isInternalInput, type InputSpec, type InputStatus } from "../input/model.ts";
import { TOPIC_TYPE, type TopicResource, type TopicStatus } from "./model.ts";
import { topicSubtree } from "./tree.ts";
import { isRootTopic } from "./boundary.ts";

export const externalInput = (spec: Pick<InputSpec, "origin">) =>
  spec.origin === "channel" || spec.origin === "source" || spec.origin === "aide:handoff";

export function queuedBusiness(topic: TopicResource, context: ResourceValidationContext, includeUnbatched: boolean): boolean {
  const pending = (name: string, uid: string) => context.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name, value: uid } })
    .some(input => !isInternalInput(input.spec) && (includeUnbatched || inputAttention(input.spec) !== InputAttention.Deferred));
  return pending("assignedPending", topic.metadata.uid) || !!context.list(BATCH_TYPE, { matchIndex: { name: "open", value: topic.metadata.uid } }).length
    || topicSubtree(topic, parent => context.list<TopicResource["spec"], TopicStatus>(TOPIC_TYPE, {
      matchIndex: { name: "parent", value: parent.metadata.uid } })).some(t => pending("unassigned", t.metadata.uid));
}

/** @spec External arrivals wake the domain. Replaying or filing older evidence preserves the latest arrival.
 * @link docs/personal/secretary.md#领域静默
 */
export function externalActivity(topic: TopicResource, at: string): Partial<TopicStatus> {
  const lastInputAt = topic.status.lastInputAt && topic.status.lastInputAt > at ? topic.status.lastInputAt : at;
  if (!isRootTopic(topic)) return { lastInputAt };
  return { lastInputAt, phase: "active", ...(topic.status.phase === "dormant" ? { compactOnWake: true } : {}) };
}
