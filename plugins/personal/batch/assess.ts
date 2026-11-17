import { completeChiefWork } from "../topic/workload.ts";
import { z } from "zod";
import type { ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { WorkInputRequestSchema } from "../model.ts";
import { resourceRef, topicScope } from "../input/state.ts";
import { isInternalInput } from "../input/model.ts";
import { agentCall } from "../observation/reference.ts";
import { prepareWorkRequests } from "../topic/assess.ts";
import type { TopicResource } from "../topic/model.ts";
import { commitStatus } from "../status.ts";
import { batchById, batchMembers } from "./members.ts";
import { batchFinished } from "./model.ts";

export const AssessBatchSchema = z.object({ batchId: z.string().min(1), summary: z.string().min(1).max(1000),
  workRequests: z.array(z.object({ inputId: z.string().min(1), workUid: z.string().min(1), request: WorkInputRequestSchema }).strict()).max(50).default([]) }).strict();
export type AssessBatch = z.input<typeof AssessBatchSchema>;
/** @spec Chief completes one Batch receipt; Input reconciliation projects the result to its immutable members.
 * @spec Explicit Work requests retain their original Input's evidence and authority, atomically with Batch completion.
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
    const members = await batchMembers(resources, batch), topics = await topicScope(resources, resourceRef(topic));
    if (args.workRequests.some(request => !members.some(input => input.metadata.name === request.inputId))) throw new Error("Work request must refer to a Batch member");
    if (new Set(args.workRequests.map(request => JSON.stringify([request.inputId, request.workUid]))).size !== args.workRequests.length) throw new Error("Duplicate Work request");
    const at = new Date().toISOString(), writes: ResourceCommit[] = [], workGuards = new Map<string, ResourceCommit>();
    for (const input of members) {
      const requests = args.workRequests.filter(request => request.inputId === input.metadata.name);
      if (!requests.length) continue;
      if (isInternalInput(input.spec)) throw new Error("Maintenance cannot hand off Work");
      const { handle, guards } = await prepareWorkRequests(resources, input, topics, requests, at);
      for (const guard of guards) if (guard.operation === "patchStatus") workGuards.set(guard.resource.metadata.uid, guard);
      writes.push({ operation: "patchStatus", resource: input, patch: { handle } });
    }
    try {
      await commitStatus(resources, [...workGuards.values(), ...writes,
        { operation: "patchStatus", resource: batch, patch: { phase: "completed", assess: { ...batch.status.assess, lastError: undefined, errorAt: undefined, retryable: undefined, completedAt: at, result: { summary: args.summary, disposition: "completed" }, completedBy: agentCall(topic.status, toolCallId) } } },
        { operation: "patchStatus", resource: topic, patch: { chiefWorkload: completeChiefWork(topic, at) } }]);
      return { assessedBatch: args.batchId };
    } catch (error) { if (n >= 8 || !/version conflict/.test(String(error))) throw error; }
  }
}
