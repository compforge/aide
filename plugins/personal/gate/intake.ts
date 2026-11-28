import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import type { TopicResource } from "../topic/model.ts";
import { isGateTopic } from "../topic/boundary.ts";
import { immediate } from "../execution/input.ts";
import { topicPolicy } from "../topic/config.ts";
import { preparedInputs } from "../chief/queue.ts";

export async function submitGatePending(context: PluginContext, execution: ReconcileContext, owner: Readonly<TopicResource>) {
  if (!isGateTopic(owner) || !owner.status.execution) return;
  const ready = await preparedInputs(context.resources, owner, 10, true, topicPolicy(context.instance.config.topic).trigger.intervalSeconds * 1000);
  if (ready.length) {
    const urgent = ready.filter(i => immediate(i.spec));
    const inputs = urgent.length ? urgent : ready;
    const result = await execution.verbs.action<{ accepted: boolean; reason?: string }>("submit_topic", {
      inputId: inputs[0]!.metadata.name, inputIds: inputs.map(i => i.metadata.name), operation: urgent.length ? "steer" : "followUp",
    });
    if (result.state === "failure") throw new Error(`Agent Input admission failed: ${result.error ?? "unknown error"}`);
    context.logger.info("Gate conversation input notification", { attributes: { topicUid: owner.metadata.uid,
      count: inputs.length,
      operation: urgent.length ? "steer" : "followUp", accepted: result.state === "success" && result.value.accepted } });
    return result.state === "success" && (result.value.accepted || ["not_running", "admission_conflict"].includes(result.value.reason ?? ""))
      ? { requeueAfterMs: 100 } : undefined;
  }
}
