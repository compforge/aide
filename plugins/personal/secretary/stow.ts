import { isResourceVersionConflict, type PluginContext } from "@compforge/aide-plugin";
import { deliveryRetryDue, INPUT_TYPE, InputAttention, type InputSpec, type InputStatus } from "../input/model.ts";
import { inputRef, resourceRef } from "../input/state.ts";
import { inWorkWindow } from "../topic/activity.ts";
import type { TopicPolicy } from "../topic/config.ts";
import type { TopicResource } from "../topic/model.ts";
import { preparedIntake } from "./intake.ts";
import { digest } from "../identity.ts";
import { commitStatus } from "../status.ts";

/** @spec Only the final idle selection may reserve an observed prompt for Stow. The reservation
 * and its recoverable Input commit together, so a crash or failed compact cannot spend the sample twice.
 * @link docs/personal/secretary.md#stow
 */
export async function selectStow(context: Pick<PluginContext, "resources" | "logger">, root: TopicResource, policy: TopicPolicy) {
  const ref = resourceRef(root);
  const topic = await context.resources.get<TopicResource["spec"], TopicResource["status"]>(ref);
  if (!topic || topic.status.execution || !inWorkWindow(topic, policy)) return;
  const pending = (await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
    matchIndex: { name: "internalPending", value: JSON.stringify([ref.uid, "aide:stow"]) }, limit: 1 })).items[0];
  if (pending) return !pending.status.assess?.executionId && deliveryRetryDue(pending.status.assess, policy.trigger.intervalSeconds * 1000) ? pending : undefined;
  const agent = topic.status.agent;
  if (!agent?.sessionId || agent.stowInputId || agent.promptTokens === undefined || agent.promptTokens <= policy.stowPromptTokens) return;
  const ready = await preparedIntake(context.resources, topic, false, policy.trigger.intervalSeconds * 1000);
  if (ready.inputs.length) return;
  const { promptTokens } = agent;
  const id = `stow-${digest([ref.uid, topic.metadata.resourceVersion])}`;
  const at = new Date().toISOString();
  try {
    await commitStatus(context.resources, [
      { operation: "create", type: INPUT_TYPE, name: id,
        spec: { origin: "aide:stow", originId: "personal.topic", originRef: ref, topicId: topic.spec.id,
          attention: InputAttention.Normal, text: "Compact the current Chief session.",
          observation: { sessionId: agent.sessionId, promptTokens, lastInputAt: topic.status.lastInputAt } },
        status: { topic: ref, route: { completedAt: at, result: { topics: [ref], reason: "Idle session maintenance" } }, assess: { topic: ref } } },
      { operation: "patchStatus", resource: topic, patch: { agent: { ...agent, stowInputId: id } } },
    ]);
  } catch (error) {
    if (isResourceVersionConflict(error) || (error instanceof Error && error.name === "ResourceAlreadyExists")) return;
    throw error;
  }
  context.logger.info("Secretary selected Stow", { attributes: { topicUid: ref.uid, inputId: id, promptTokens } });
  return context.resources.get<InputSpec, InputStatus>(inputRef(id));
}
