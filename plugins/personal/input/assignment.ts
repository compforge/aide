import type { PluginContext, ResourceValidationContext, Watch } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "./model.ts";
import { resourceRef, type Input } from "./state.ts";
import { patchStatus } from "../status.ts";
import { TOPIC_TYPE, type TopicResource } from "../topic/model.ts";
import { readTopicRoot, readTopicSubtree } from "../topic/tree.ts";
import { requireTopic } from "../topic/ownership.ts";

/** @spec Assignment is separate from material ownership and never resets admission or completion.
 * @link docs/personal/input.md#挂载分派与执行
 * @case tests/input-assignment.test.ts
 */
export async function assignInput(context: Pick<PluginContext, "resources" | "logger">, input: Input) {
  if (input.metadata.deletionTimestamp || !input.status.topic || !input.status.assess || input.status.assess.completedAt) return;
  const root = await readTopicRoot(context.resources, input.status.topic);
  if (!root || input.status.assess?.topic?.uid === root.metadata.uid) return;
  await patchStatus(context.resources, input, { assess: { ...input.status.assess, topic: resourceRef(root) } });
  context.logger.info("Input processing assigned", { attributes: { inputId: input.metadata.name,
    topicUid: input.status.topic.uid, previousAssigneeUid: input.status.assess?.topic?.uid ?? null,
    assigneeUid: root.metadata.uid, executionId: input.status.assess?.executionId ?? null } });
}

/** Validate the real ancestry in the same transaction as assignment/admission, including ancestor-only moves. */
export function guardAssessment(previous: Input, current: Input, context: ResourceValidationContext) {
  const changed = previous.status.assess?.topic?.uid !== current.status.assess?.topic?.uid;
  const admitted = !previous.status.assess?.executionId && !!current.status.assess?.executionId;
  if (!changed && !admitted) return;
  if (!current.status.assess?.topic) throw new Error("Input has no processing Topic");
  let root = requireTopic(current.status.topic, context);
  const seen = new Set<string>();
  while (root.spec.parentRef) {
    if (seen.has(root.metadata.uid)) throw new Error("Topic parent cycle");
    seen.add(root.metadata.uid);
    root = requireTopic(root.spec.parentRef, context);
  }
  if (root.metadata.uid !== requireTopic(current.status.assess.topic, context).metadata.uid)
    throw new Error("Input processing assignment changed; reconcile again");
  if (admitted && root.status.execution?.id !== current.status.assess.executionId)
    throw new Error("Input admission requires the assigned Chief execution");
}

export function registerInputs(context: PluginContext) {
  const topology: Watch = { resourceType: TOPIC_TYPE, handler: { create: async () => [], delete: async () => [], update: async ({ oldObject, newObject }) => {
    const old = oldObject as TopicResource, topic = newObject as TopicResource;
    if (old.spec.parentRef?.uid === topic.spec.parentRef?.uid) return [];
    // Structural changes fan out once. Ordinary Input scheduling never discovers the responsibility tree.
    const requests = [];
    for (const member of await readTopicSubtree(context.resources, resourceRef(topic))) {
      // One indexed snapshot per member avoids expiring continuation tokens while live Inputs change.
      const inputs = await context.resources.list<InputSpec, InputStatus>(INPUT_TYPE, {
        matchIndex: { name: "assessPending", value: member.metadata.uid } });
      requests.push(...inputs.map(i => ({ name: i.metadata.name, namespace: i.metadata.namespace })));
    }
    return requests;
  } } };
  const changed: Watch = { resourceType: INPUT_TYPE, handler: { create: async () => [], delete: async () => [], update: async ({ oldObject, newObject }) => {
    const a = oldObject as Input, b = newObject as Input;
    return a.status.topic?.uid !== b.status.topic?.uid ? [{ name: b.metadata.name, namespace: b.metadata.namespace }] : [];
  } } };
  context.controllers.register({ resourceType: INPUT_TYPE, maxConcurrency: 4, watches: [changed, topology],
    reconcile: async (_execution, input: Input) => assignInput(context, input) });
}
