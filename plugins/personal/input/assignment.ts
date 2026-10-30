import { retryOnConflict, type PluginContext, type ResourceValidationContext, type Watch } from "@compforge/aide-plugin";
import { INPUT_TYPE } from "./model.ts";
import { resourceRef, type Input } from "./state.ts";
import { patchStatus } from "../status.ts";
import { readTopicRoot } from "../topic/tree.ts";
import { requireTopic } from "../topic/ownership.ts";

/** @spec Assignment is separate from material ownership and never resets admission or completion.
 * @link docs/personal/input.md#挂载分派与执行
 * @case tests/input-assignment.test.ts
 */
export async function assignInput(context: Pick<PluginContext, "resources" | "logger">, input: Input) {
  return retryOnConflict(async () => {
    const current = await context.resources.get<Input["spec"], Input["status"]>(resourceRef(input));
    if (!current) return;
    if (current.metadata.deletionTimestamp || !current.status.topic || !current.status.assess || current.status.assess.completedAt || current.status.assess.executionId) return;
    const root = await readTopicRoot(context.resources, current.status.topic);
    if (!root || current.status.assess?.topic?.uid === root.metadata.uid) return;
    await patchStatus(context.resources, current, { assess: { ...current.status.assess, topic: resourceRef(root) } });
    context.logger.info("Input processing assigned", { attributes: { inputId: current.metadata.name,
      topicUid: current.status.topic.uid, previousAssigneeUid: current.status.assess?.topic?.uid ?? null,
      assigneeUid: root.metadata.uid, executionId: current.status.assess?.executionId ?? null } });
  });
}

/** Validate the real ancestry in the same transaction as assignment/admission, including ancestor-only moves. */
export function guardAssessment(previous: Input, current: Input, context: ResourceValidationContext) {
  const changed = previous.status.assess?.topic?.uid !== current.status.assess?.topic?.uid;
  const admitted = !previous.status.assess?.executionId && !!current.status.assess?.executionId;
  if (changed && (previous.status.assess?.executionId || previous.status.assess?.completedAt))
    throw new Error("Admitted assessment owner is immutable");
  if (!changed && !admitted) return;
  if (!current.status.assess?.topic) {
    if (previous.status.assess?.executionId || previous.status.assess?.completedAt || admitted) throw new Error("Cannot invalidate an admitted assessment");
    return;
  }
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
  const changed: Watch = { resourceType: INPUT_TYPE, handler: { create: async () => [], delete: async () => [], update: async ({ oldObject, newObject }) => {
    const a = oldObject as Input, b = newObject as Input;
    return (a.status.topic?.uid !== b.status.topic?.uid || (!!a.status.assess?.topic && !b.status.assess?.topic)) ? [{ name: b.metadata.name, namespace: b.metadata.namespace }] : [];
  } } };
  context.controllers.register({ resourceType: INPUT_TYPE, maxConcurrency: 4, watches: [changed],
    reconcile: async (_execution, input: Input) => assignInput(context, input) });
}

/** Invalidation is durable; the Input Watch and Topic repair both rebuild missing assignments. */
export async function invalidateAssignment(context: Pick<PluginContext, "resources">, input: Input) {
  if (!input.status.assess?.topic || input.status.assess.executionId || input.status.assess.completedAt) return;
  const { topic: _, ...assess } = input.status.assess;
  await patchStatus(context.resources, input, { assess });
}
