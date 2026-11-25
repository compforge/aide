import type { PluginContext } from "@compforge/aide-plugin";
import { assignmentWatch } from "../input/state.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { commitStatus } from "../status.ts";
import { digest } from "../identity.ts";
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
  if (matter.metadata.deletionTimestamp) return;
  const { items: materials } = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, { limit: 16, matchIndex: { name: "handlePending", value: matter.metadata.uid } });
  if (matter.status.closure) {
    if (!materials.length) return;
    await commitStatus(context.resources, materials.map(i => ({ operation: "patchStatus", resource: i, patch: { handle: { ...i.status.handle,
      [matter.metadata.uid]: { ...i.status.handle![matter.metadata.uid]!, completedAt: matter.status.closure!.at, result: { disposition: "cancelled", summary: "Ongoing closed" } },
    } } })));
    return { requeueAfterMs: 1 };
  }
  const scheduled = matter.status.nextCheckAt && !matter.status.followupInputId ? matter.status.nextCheckAt : undefined;
  if (!scheduled && !materials.length) return;
  const checkDue = scheduled !== undefined && Date.parse(scheduled) <= now;
  const dueAt = materials.length && !checkDue ? new Date(now).toISOString() : scheduled!;
  const requestId = materials.length && !checkDue ? `followup-${digest([matter.metadata.uid, materials.map(i => i.metadata.uid)])}` : followupInputId(matter)!;
  const delay = Date.parse(dueAt) - now;
  if (delay > 0) return { requeueAfterMs: Math.min(delay, 2_147_483_647) };
  const root = await readTopicRoot(context.resources, matter.spec.topic);
  if (!root || !isRootTopic(root)) return;
  const instructions = `Read Ongoing ${matter.metadata.name} and verify current evidence before acting. ${materials.length ? `Read newly attached Inputs: ${materials.map(i => i.metadata.name).join(", ")}. ` : ""} ${matter.spec.question ?? "Check whether the matter still needs a response."}`;
  await tryCreateMaintenanceInput(context, root, dueAt, await maintenanceAgenda(context.resources, [], policy),
    "aide:followup", materials.length ? "work_input" : matter.spec.question ? "question_due" : "ongoing_check_due",
    { ongoing: matter, materials, instructions, cooldownSeconds: policy.capacityCooldownSeconds }, policy, requestId);
  return { requeueAfterMs: Math.max(1, policy.capacityCooldownSeconds * 1000) };
}

export function registerOngoingMaintenance(context: PluginContext) {
  const policy = topicPolicy(context.instance.config.topic);
  context.controllers.register({ name: "secretary-ongoings", resourceType: ONGOING_TYPE, maxConcurrency: 4,
    watches: [assignmentWatch("handle", "Ongoing"), { resourceType: ONGOING_TYPE, handler: {
      create: async () => [], delete: async () => [],
      update: async ({ oldObject, newObject }) => {
        const before = (oldObject as OngoingResource).status, after = (newObject as OngoingResource).status;
        return before.nextCheckAt !== after.nextCheckAt || !!before.closure !== !!after.closure
          ? [{ name: newObject.metadata.name, namespace: newObject.metadata.namespace }] : [];
      },
    } }],
    reconcile: (_execution, matter: OngoingResource) => prepareOngoingCheck(context, matter, policy) });
}
