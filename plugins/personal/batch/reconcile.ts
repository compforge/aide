import type { PluginContext, ResourceClient, Watch } from "@compforge/aide-plugin";
import { INPUT_TYPE, InputAttention, inputAttention, isInternalInput, type InputSpec, type InputStatus } from "../input/model.ts";
import { resourceRef, type Input } from "../input/state.ts";
import { commitStatus, patchStatus } from "../status.ts";
import { randomUUID } from "node:crypto";
import { readTopicRoot } from "../topic/tree.ts";
import type { TopicResource } from "../topic/model.ts";
import type { TopicPolicy } from "../topic/config.ts";
import { BATCH_TYPE, batchFinished, type Batch, type BatchSpec, type BatchStatus } from "./model.ts";
import { batchKey, batchMembers, unclaimed } from "./members.ts";

export async function cancelBatch(resources: ResourceClient, batch: Batch, reason: string) {
  if (batchFinished(batch)) return;
  await patchStatus(resources, batch, { phase: "cancelled", assess: { completedAt: new Date().toISOString(), result: { summary: reason, disposition: "cancelled" } } });
}
export async function reconcileBatches(context: Pick<PluginContext, "resources" | "logger">, topic: TopicResource) {
  const page = await context.resources.page<BatchSpec, BatchStatus>(BATCH_TYPE, { matchIndex: { name: "open", value: topic.metadata.uid }, limit: 40 });
  for (const batch of page.items) {
    if (batch.status.phase === "running") continue;
    // A create interrupted before the atomic membership commit has no scheduled work.
    if (batch.status.phase === "preparing" && Date.now() - Date.parse(batch.metadata.creationTimestamp) < 60_000) continue;
    const members = await batchMembers(context.resources, batch);
    const roots = await Promise.all(members.map(m => m.status.topic ? readTopicRoot(context.resources, m.status.topic) : undefined));
    if (batch.status.phase === "ready" && members.length && members.every((m, n) => unclaimed(m) && roots[n]?.metadata.uid === topic.metadata.uid)) continue;
    await cancelBatch(context.resources, batch, "Batch membership or ownership changed before admission");
    context.logger.info("Secretary batch cancelled before admission", { attributes: { batchId: batch.metadata.uid, topicUid: topic.metadata.uid } });
  }
}
/** @spec Membership assignment and readiness commit atomically. Empty preparing resources never enter Chief queues.
 * @spec Count/age preparation is independent of an idle Chief; original attention and authority remain unchanged.
 * @case tests/input-batch.test.ts
 * @link docs/personal/batch.md
 */
export async function prepareInputs(context: Pick<PluginContext, "resources" | "logger">, topic: TopicResource, policy: TopicPolicy, now = Date.now()) {
  await reconcileBatches(context, topic);
  const groups = new Map<string, Input[]>();
  const page = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "secretaryPending", value: topic.metadata.uid }, limit: 100 });
  let next = policy.trigger.intervalSeconds * 1000;
  for (const input of page.items) {
    if (!unclaimed(input) || inputAttention(input.spec) !== InputAttention.Deferred || isInternalInput(input.spec) || input.spec.handoff) continue;
    const key = batchKey(input), group = groups.get(key) ?? [];
    group.push(input); groups.set(key, group);
  }
  for (const group of groups.values()) {
    const first = group[0]!, rule = policy.deferred;
    const due = Date.parse(first.metadata.creationTimestamp) + rule.maxWaitSeconds * 1000;
    if (group.length < rule.count && due > now) { next = Math.min(next, due - now); continue; }
    const members = group.slice(0, 10), at = new Date(now).toISOString();
    const name = `batch-${randomUUID()}`;
    let batch: Batch | undefined;
    try {
      batch = await context.resources.create<BatchSpec, BatchStatus>(BATCH_TYPE, { name,
        spec: { topic: resourceRef(topic), attention: InputAttention.Normal,
          oldestAt: first.metadata.creationTimestamp }, status: { phase: "preparing" } });
      await commitStatus(context.resources, [
        ...members.map(member => ({ operation: "patchStatus" as const, resource: member, patch: { batchId: batch!.metadata.uid, batchAt: at } })),
        { operation: "patchStatus", resource: batch, patch: { phase: "ready" } },
      ]);
    } catch (error) {
      if (batch) await cancelBatch(context.resources, batch, "Preparation did not commit");
      if (!String(error).includes("Resource capacity exhausted")) throw error;
      context.logger.warn("Secretary waiting for Batch capacity", { attributes: { topicUid: topic.metadata.uid, inputIds: members.map(m => m.metadata.name) } });
      continue;
    }
    context.logger.info("Secretary batch prepared", { attributes: { topicUid: topic.metadata.uid, batchId: batch.metadata.uid, count: members.length,
      oldestAt: first.metadata.creationTimestamp, reason: group.length >= rule.count ? "count" : "age" } });
  }
  return Math.max(1, next);
}

/** Both Topic controllers observe Batch changes; status-only readiness must wake intake and Chief. */
export function batchWatch(intake = false): Watch {
  const requests = (batch: Batch) => [{ name: batch.spec.topic.name, namespace: batch.spec.topic.namespace }];
  return { resourceType: BATCH_TYPE, handler: { create: async ({ object }) => requests(object as Batch),
    delete: async ({ object }) => requests(object as Batch), update: async ({ oldObject, newObject }) => {
      const a = oldObject as Batch, b = newObject as Batch;
      return intake && a.status.phase === "running" && b.status.phase === "ready" ? [] : requests(b);
    } } };
}
