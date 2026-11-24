import type { PluginContext } from "@compforge/aide-plugin";
import { ONGOING_TYPE, followupInputId, type OngoingResource } from "../ongoing/model.ts";
import { isRootTopic } from "../topic/boundary.ts";
import { readTopicRoot } from "../topic/tree.ts";
import { topicPolicy, type TopicPolicy } from "../topic/config.ts";
import { maintenanceAgenda } from "./maintenance.ts";
import { tryCreateMaintenanceInput } from "./input.ts";

/** @spec One durable Input per Ongoing check plan. A competing pending Input leaves this check due.
 * @link docs/personal/ongoing.md
 */
export async function prepareOngoingCheck(context: PluginContext, matter: OngoingResource, policy: TopicPolicy, now = Date.now()) {
  const requestId = followupInputId(matter);
  if (!requestId || matter.status.followupInputId === requestId || !matter.spec.checkAt) return;
  const delay = Date.parse(matter.spec.checkAt) - now;
  if (delay > 0) return { requeueAfterMs: Math.min(delay, 2_147_483_647) };
  const root = await readTopicRoot(context.resources, matter.spec.topic);
  if (!root || !isRootTopic(root)) return;
  const instructions = `Read Ongoing ${matter.metadata.name} and verify current evidence before acting. ${matter.spec.question ?? "Check whether the matter still needs a response."}`;
  await tryCreateMaintenanceInput(context, root, matter.spec.checkAt, await maintenanceAgenda(context.resources, [], policy),
    "aide:followup", matter.spec.question ? "question_due" : "ongoing_check_due",
    { ongoing: matter, instructions, cooldownSeconds: policy.capacityCooldownSeconds }, policy, requestId);
  return { requeueAfterMs: Math.max(1, policy.capacityCooldownSeconds * 1000) };
}

export function registerOngoingMaintenance(context: PluginContext) {
  const policy = topicPolicy(context.instance.config.topic);
  context.controllers.register({ name: "secretary-ongoings", resourceType: ONGOING_TYPE, maxConcurrency: 4,
    reconcile: (_execution, matter: OngoingResource) => prepareOngoingCheck(context, matter, policy) });
}
