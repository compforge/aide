import { listInternalCandidates } from "../secretary/reconcile.ts";
import { selectIntake, type DispatchCandidate } from "../secretary/candidate.ts";
import { preparedIntake } from "../secretary/intake.ts";
import { inWorkWindow } from "../topic/activity.ts";
import { resourceRef } from "../input/state.ts";
import { inputAttention } from "../input/model.ts";
import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import type { TopicResource } from "../topic/model.ts";
import { isGateTopic, isRootTopic } from "../topic/boundary.ts";
import { immediate } from "../execution/input.ts";
import { topicPolicy } from "../topic/config.ts";
import { preparedInputs } from "../chief/queue.ts";

export async function submitTopicPending(context: PluginContext, execution: ReconcileContext, owner: Readonly<TopicResource>) {
  if (!owner.status.execution) return;
  const gate = isGateTopic(owner);
  const ready = await preparedInputs(context.resources, owner, gate ? 10 : 1, true, topicPolicy(context.instance.config.topic).trigger.intervalSeconds * 1000);
  if (ready.length) {
    const urgent = ready.filter(i => immediate(i.spec));
    const inputs = urgent.length ? urgent : ready;
    const result = await execution.verbs.action<{ accepted: boolean; reason?: string }>("submit_topic", {
      inputId: inputs[0]!.metadata.name, inputIds: inputs.map(i => i.metadata.name), operation: urgent.length ? "steer" : "followUp",
    });
    if (result.state === "failure") throw new Error(`Agent Input admission failed: ${result.error ?? "unknown error"}`);
    context.logger.info("Topic direct Input notification", { attributes: { topicUid: owner.metadata.uid,
      count: inputs.length,
      operation: urgent.length ? "steer" : "followUp", accepted: result.state === "success" && result.value.accepted } });
    return result.state === "success" && (result.value.accepted || ["not_running", "admission_conflict"].includes(result.value.reason ?? ""))
      ? { requeueAfterMs: 100 } : undefined;
  }
}

/** An idle Chief compares accumulated arrivals, sealed Batches and eligible maintenance.
 * Only a selected maintenance candidate needs a new Input. Active business arrivals use submitTopicPending.
 */
export async function selectChiefIntake(context: PluginContext, initial: TopicResource, policy = topicPolicy(context.instance.config.topic)) {
  const interval = policy.trigger.intervalSeconds * 1000;
  const topic = await context.resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(initial));
  if (!topic || topic.metadata.deletionTimestamp || topic.status.execution || !isRootTopic(topic)) return { requeueAfterMs: interval };
  const open = inWorkWindow(topic);
  const ready = await preparedIntake(context.resources, topic, !open, interval);
  const first = ready.inputs[0], attention = ready.batch?.spec.attention ?? (first && inputAttention(first.spec));
  if (!open) return { requeueAfterMs: interval, intake: first ? ready : undefined };
  const internal = await listInternalCandidates(context, topic, policy, !!first);
  const candidates: DispatchCandidate[] = [];
  if (first && attention) candidates.push({ attention, createdAt: (ready.batch ?? first).metadata.creationTimestamp, intake: ready });
  candidates.push(...internal.candidates);
  return { requeueAfterMs: internal.requeueAfterMs, intake: await selectIntake(candidates) };
}
