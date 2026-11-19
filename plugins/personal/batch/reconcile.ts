import type { PluginContext, ResourceClient, Watch } from "@compforge/aide-plugin";
import { patchStatus } from "../status.ts";
import { isRootTopic } from "../topic/boundary.ts";
import { readTopicRoot } from "../topic/tree.ts";
import type { TopicResource } from "../topic/model.ts";
import { BATCH_TYPE, batchFinished, type Batch, type BatchSpec, type BatchStatus } from "./model.ts";
import { batchMembers, unclaimed } from "./members.ts";

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
    if (isRootTopic(topic) && batch.status.phase === "ready" && members.length && members.every((m, n) => unclaimed(m) && roots[n]?.metadata.uid === topic.metadata.uid)) continue;
    await cancelBatch(context.resources, batch, "Batch membership or ownership changed before admission");
    context.logger.info("Secretary batch cancelled before admission", { attributes: { batchId: batch.metadata.uid, topicUid: topic.metadata.uid } });
  }
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
