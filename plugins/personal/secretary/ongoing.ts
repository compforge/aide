import type { PluginContext, Watch } from "@compforge/aide-plugin";
import type { TopicResource } from "../topic/model.ts";
import { INPUT_TYPE, InputAttention, type InputSpec, type InputStatus } from "../input/model.ts";
import { commitStatus } from "../status.ts";
import { assignmentWatch, inputRef, type Input } from "../input/state.ts";
import { digest } from "../identity.ts";
import { ONGOING_TYPE, nextCheckAfterRetention, nextCheckAfterDelivery, followupInputId, type OngoingResource } from "../ongoing/model.ts";
import { isRootTopic } from "../topic/boundary.ts";
import { readTopicRoot } from "../topic/tree.ts";
import { topicPolicy, type TopicPolicy } from "../topic/config.ts";
import { maintenanceAgenda } from "./maintenance.ts";
import { tryCreateMaintenanceInput } from "./input.ts";

/** @spec One durable Input per Ongoing check plan. A competing pending Input leaves this check due.
 * @link docs/personal/work.md#ongoing
 */
export async function ongoingCandidate(context: PluginContext, matter: OngoingResource, policy: TopicPolicy, now = Date.now(), expectedRootUid?: string) {
  if (matter.metadata.deletionTimestamp) return;
  const { items: materials } = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, { limit: 16, matchIndex: { name: "handlePending", value: matter.metadata.uid } });
  if (matter.status.closure) {
    if (!materials.length) return;
    await commitStatus(context.resources, materials.map(i => ({ operation: "patchStatus", resource: i, patch: { handle: { ...i.status.handle,
      [matter.metadata.uid]: { ...i.status.handle![matter.metadata.uid]!, completedAt: matter.status.closure!.at, result: { disposition: "cancelled", summary: "Ongoing closed" } },
    } } })));
    return { requeueAfterMs: 1 };
  }
  if (matter.status.followupInputId) {
    // Releases before recurring checks recorded delivery without advancing the appointment.
    const prior = await context.resources.get<InputSpec, InputStatus>(inputRef(matter.status.followupInputId));
    const deliveredAt = prior?.status.assess?.completedAt;
    const nextCheckAt = prior ? deliveredAt && nextCheckAfterDelivery(matter, prior, deliveredAt) : nextCheckAfterRetention(matter);
    if (nextCheckAt) {
      await commitStatus(context.resources, [{ operation: "patchStatus", resource: matter, patch: { followupInputId: undefined, nextCheckAt } }]);
      return { requeueAfterMs: 1 };
    }
  }
  const scheduled = matter.status.nextCheckAt && !matter.status.followupInputId ? matter.status.nextCheckAt : undefined;
  if (!scheduled && !materials.length) return;
  const checkDue = scheduled !== undefined && Date.parse(scheduled) <= now;
  const dueAt = materials.length && !checkDue ? new Date(now).toISOString() : scheduled!;
  const requestId = materials.length && !checkDue ? `followup-${digest([matter.metadata.uid, materials.map(i => i.metadata.uid)])}` : followupInputId(matter)!;
  const delay = Date.parse(dueAt) - now;
  if (delay > 0) return { requeueAfterMs: Math.min(delay, 2_147_483_647) };
  const root = await readTopicRoot(context.resources, matter.spec.topic);
  if (!root || !isRootTopic(root) || expectedRootUid && expectedRootUid !== root.metadata.uid) return;
  const instructions = `Read Ongoing ${matter.metadata.name} and verify current evidence before acting. ${materials.length ? `Read newly attached Inputs: ${materials.map(i => i.metadata.name).join(", ")}. ` : ""} Read the current question from the Ongoing.`;
  const dispatch = async () => tryCreateMaintenanceInput(context, root, dueAt, await maintenanceAgenda(context.resources, [], policy),
    "aide:followup", materials.length ? "work_input" : matter.spec.question ? "question_due" : "ongoing_check_due",
    { ongoing: matter, materials, instructions, cooldownSeconds: policy.capacityCooldownSeconds }, policy, requestId);
  const arrivals = materials.map(i => i.status.handle![matter.metadata.uid]!.assignedAt);
  if (checkDue) arrivals.push(scheduled!);
  return { candidate: { attention: InputAttention.Normal, createdAt: arrivals.sort()[0]!, dispatch }, requeueAfterMs: Math.max(1, policy.capacityCooldownSeconds * 1000) };
}

/** Ongoing changes only wake the responsible root. Root timers cover deadlines and missed notifications. */
export function ongoingWatch(context: PluginContext): Watch {
  const requests = async (matter: OngoingResource) => {
    const root = await readTopicRoot(context.resources, matter.spec.topic);
    return root ? [{ name: root.metadata.name, namespace: root.metadata.namespace }] : [];
  };
  return { resourceType: ONGOING_TYPE, handler: {
    create: ({ object }) => requests(object as OngoingResource),
    update: ({ newObject }) => requests(newObject as OngoingResource),
    delete: ({ object }) => requests(object as OngoingResource),
  } };
}

/** An attached Input can originate in another Topic; wake the Work owner even if its next check is in the future. */
export function ongoingMaterialWatch(context: PluginContext): Watch {
  const requests = async (input: Input, previous?: Input) => {
    const attached = Object.values(input.status.handle ?? {}).filter(h => h.resource.kind === "Ongoing"
      && !h.completedAt && !previous?.status.handle?.[h.resource.uid]);
    const roots = await Promise.all(attached.map(async h => {
      const matter = await context.resources.get<OngoingResource["spec"], OngoingResource["status"]>(h.resource);
      return matter && readTopicRoot(context.resources, matter.spec.topic);
    }));
    return roots.flatMap(root => root ? [{ name: root.metadata.name, namespace: root.metadata.namespace }] : []);
  };
  return { resourceType: INPUT_TYPE, handler: {
    create: ({ object }) => requests(object as Input), delete: async () => [],
    update: ({ oldObject, newObject }) => requests(newObject as Input, oldObject as Input),
  } };
}

export async function selectOngoing(context: PluginContext, topics: TopicResource[], policy: TopicPolicy) {
  const now = Date.now();
  const matters: OngoingResource[] = [];
  for (const topic of topics) matters.push(...await context.resources.list<OngoingResource["spec"], OngoingResource["status"]>(
    ONGOING_TYPE, { matchIndex: { name: "openTopic", value: topic.metadata.uid } }));
  let next = policy.trigger.intervalSeconds * 1000;
  const candidates = [];
  for (const matter of matters) {
    const result = await ongoingCandidate(context, matter, policy, now, topics[0]?.metadata.uid);
    if (result?.candidate) candidates.push(result.candidate);
    if (result) next = Math.min(next, result.requeueAfterMs);
  }
  return { candidates, requeueAfterMs: next };
}

// Closing a Work still settles material attached before closure; only the root dispatches open Work.
export function registerOngoingCleanup(context: PluginContext) {
  context.controllers.register({ name: "closed-material", resourceType: ONGOING_TYPE,
    watches: [assignmentWatch("handle", "Ongoing")], reconcile: async (_execution, matter: OngoingResource) => {
      if (matter.status.closure) return ongoingCandidate(context, matter, topicPolicy(context.instance.config.topic));
    } });
}
