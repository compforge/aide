import { completeChiefWork } from "../chief/workload.ts";
import { z } from "zod";
import type { ResourceClient } from "@compforge/aide-plugin";
import { resourceRef } from "../input/state.ts";
import { agentCall } from "../observation/reference.ts";
import type { TopicResource } from "../topic/model.ts";
import { commitStatus } from "../status.ts";
import { batchById } from "./members.ts";
import { batchFinished } from "./model.ts";

export const AssessBatchSchema = z.object({ batchId: z.string().min(1), summary: z.string().min(1).max(1000) }).strict();
export type AssessBatch = z.input<typeof AssessBatchSchema>;
/** @spec Chief completes one Batch receipt; Input reconciliation projects the result to its immutable members.
 * @link docs/personal/batch.md
 */
export async function assessBatch(resources: ResourceClient, owner: TopicResource, executionId: string, raw: unknown, toolCallId?: string) {
  const args = AssessBatchSchema.parse(raw);
  for (let n = 0; ; n++) {
    const topic = await resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(owner));
    if (!topic || topic.metadata.deletionTimestamp || topic.status.execution?.id !== executionId) throw new Error("Chief execution is no longer active");
    const batch = await batchById(resources, args.batchId);
    if (!batch || batch.metadata.deletionTimestamp || batch.spec.topic.uid !== topic.metadata.uid || batch.status.assess?.executionId !== executionId)
      throw new Error("Batch is not admitted to this Chief execution");
    if (batch.status.phase === "completed") return { assessedBatch: args.batchId };
    if (batchFinished(batch) || batch.status.phase !== "running") throw new Error("Batch is not running");
    const at = new Date().toISOString();
    try {
      await commitStatus(resources, [
        { operation: "patchStatus", resource: batch, patch: { phase: "completed", assess: { ...batch.status.assess, lastError: undefined, errorAt: undefined, retryable: undefined, completedAt: at, result: { summary: args.summary, disposition: "completed" }, completedBy: agentCall(topic.status, toolCallId) } } },
        { operation: "patchStatus", resource: topic, patch: { chiefWorkload: completeChiefWork(topic, at) } }]);
      return { assessedBatch: args.batchId };
    } catch (error) { if (n >= 8 || !/version conflict/.test(String(error))) throw error; }
  }
}
