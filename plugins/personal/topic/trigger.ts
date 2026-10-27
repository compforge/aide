import { z } from "zod";
import type { PluginContext } from "@compforge/aide-plugin";
import type { TopicResource } from "./model.ts";
import { INPUT_TYPE, InputAttention, type InputSpec, type InputStatus } from "../input/model.ts";
import { inputRef, resourceRef } from "../input/state.ts";
import { digest } from "../chief-model.ts";

/** Root Topics opt into Chief idle reviews; cadence belongs to Chief configuration. */
export const TopicTriggerSchema = z.object({ enabled: z.boolean().default(true) }).strict();
export type TopicTrigger = z.infer<typeof TopicTriggerSchema>;
export const topicTrigger = (trigger?: TopicTrigger): TopicTrigger => TopicTriggerSchema.parse(trigger ?? {});

/**
 * @spec An idle review is born routed to its root, with normal attention and no new authority.
 * @why Advancing the check and creating its Input atomically prevents duplicate reviews; the Topic version fences regrouping and concurrent execution.
 * @spec Timer Inputs do not refresh lastInputAt, so periodic reflection cannot keep a quiet Topic alive forever.
 * @case tests/topic-trigger.test.ts
 * @link docs/personal/topic.md#topic-定时回顾
 */
export async function createTriggerInput(context: Pick<PluginContext, "resources" | "logger">, topic: Readonly<TopicResource>, nextTriggerAt: string) {
  if (topic.spec.parentRef || topic.metadata.deletionTimestamp || topic.status.execution || topic.status.weaveLock || !topicTrigger(topic.spec.trigger).enabled)
    throw new Error("Idle review requires an enabled, idle root Topic");
  const dueAt = topic.status.nextTriggerAt!;
  const inputId = `topic-trigger-${digest([topic.metadata.uid, dueAt])}`;
  const at = new Date().toISOString();
  const idleSince = topic.status.idleSince ?? topic.metadata.creationTimestamp;
  const target = resourceRef(topic);
  const spec: InputSpec = {
    origin: "trigger", originId: "personal.topic-trigger", originRef: target, topicId: topic.spec.id, attention: InputAttention.Normal,
    text: `Scheduled review at ${at}: reflect on this Topic's current understanding, relevant memory, unresolved questions, Work and pending Inputs, even if no new information has arrived. Decide whether anything needs attention within existing authorization. This is not a new user request; communication is optional. Record the review with assess_input, including when nothing needs action.`,
    observation: { dueAt, triggeredAt: at, idleSince },
  };
  const status: InputStatus = {
    route: { completedAt: at, result: { topics: [target], reason: "Scheduled review of this root Topic" } },
    assess: { [target.uid]: { resource: target, assignedAt: at } },
  };
  await context.resources.commit([
    { operation: "patchStatus", resource: topic, patch: { nextTriggerAt } },
    { operation: "create", type: INPUT_TYPE, name: inputId, spec, status },
  ]);
  context.logger.info("Chief idle review requested", { attributes: { topicUid: topic.metadata.uid, inputId, dueAt, idleSince } });
  return (await context.resources.get<InputSpec, InputStatus>(inputRef(inputId)))!;
}
