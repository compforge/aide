import { isDeepStrictEqual } from "node:util";
import type { ResourceValidationContext } from "@compforge/aide-plugin";
import { TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "./model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { WORK_TYPES, type WorkResource } from "../resources.ts";
import { requireOrganization, requireTopic } from "./ownership.ts";

/** @spec Reparenting a descendant requires a quiescent subtree at commit time, including newly arrived work.
 * @why Querying current indexed dependencies rejects intake races and phantom children without writing them.
 * @link docs/personal/topic.md#归属调整与责任交接
 * @case tests/topic-ownership.test.ts
 */
export function guardTopicOrganization(current: TopicResource, context: ResourceValidationContext, previous?: TopicResource) {
  const changed = !previous || !isDeepStrictEqual(previous.spec.parentRef, current.spec.parentRef);
  if (!changed) return;
  const organization = current.status.organization;
  if (organization?.executionId && (!previous || !isDeepStrictEqual(previous.status.organization, organization))) {
    const topics = previous ? [previous] : [];
    if (current.spec.parentRef) topics.push(requireTopic(current.spec.parentRef, context));
    const actor = requireOrganization(organization, context, topics);
    if (previous?.metadata.uid === actor.metadata.uid) throw new Error("Only a descendant may move or become independent");
  }
  // Weave can attach an active root; its existing Chief drains naturally. Descendant handoff must be idle.
  if (!previous?.spec.parentRef) return;
  const subtree = [previous], seen = new Set([previous.metadata.uid]);
  for (const topic of subtree) {
    if (topic.status.execution) throw new Error("Subtree still has active processing; retry after completion");
    const inputs = context.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "assessPending", value: topic.metadata.uid } });
    if (inputs.some(i => i.status.assess?.executionId)) throw new Error("Subtree still has active processing; retry after completion");
    for (const type of WORK_TYPES) {
      if (context.list<WorkResource["spec"], WorkResource["status"]>(type, { matchIndex: { name: "topic", value: topic.metadata.uid } })
        .some(w => w.status.execution)) throw new Error("Subtree still has active processing; retry after completion");
    }
    for (const child of context.list<TopicSpec, TopicStatus>(TOPIC_TYPE, { matchIndex: { name: "parent", value: topic.metadata.uid } })) {
      if (!seen.has(child.metadata.uid)) { seen.add(child.metadata.uid); subtree.push(child); }
    }
  }
}
