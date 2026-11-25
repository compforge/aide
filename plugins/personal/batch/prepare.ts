import type { PluginContext } from "@compforge/aide-plugin";
import { randomUUID } from "node:crypto";
import { InputAttention } from "../input/model.ts";
import { resourceRef, type Input } from "../input/state.ts";
import type { TopicResource } from "../topic/model.ts";
import { commitStatus } from "../status.ts";
import { BATCH_TYPE, type Batch, type BatchSpec, type BatchStatus } from "./model.ts";
import { cancelBatch } from "./reconcile.ts";

/** @spec Membership assignment and readiness commit atomically. Empty preparing resources never enter Chief queues.
 * @case tests/input-batch.test.ts
 * @link docs/personal/input.md#batch
 */
export async function prepareBatch(context: Pick<PluginContext, "resources" | "logger">, topic: TopicResource, members: readonly Input[], at: string) {
  const name = `batch-${randomUUID()}`;
  let batch: Batch | undefined;
  try {
    batch = await context.resources.create<BatchSpec, BatchStatus>(BATCH_TYPE, { name,
      spec: { topic: resourceRef(topic), attention: InputAttention.Normal,
        oldestAt: members[0]!.metadata.creationTimestamp }, status: { phase: "preparing" } });
    await commitStatus(context.resources, [
      ...members.map(member => ({ operation: "patchStatus" as const, resource: member, patch: { batchId: batch!.metadata.uid, batchAt: at } })),
      { operation: "patchStatus", resource: batch, patch: { phase: "ready" } },
    ]);
  } catch (error) {
    if (batch) await cancelBatch(context.resources, batch, "Preparation did not commit");
    if (!String(error).includes("Resource capacity exhausted")) throw error;
    context.logger.warn("Secretary waiting for Batch capacity", { attributes: { topicUid: topic.metadata.uid, inputIds: members.map(m => m.metadata.name) } });
    return;
  }
  return batch;
}
