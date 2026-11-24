import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ResourceDefinition, ResourceValidationContext } from "@compforge/aide-plugin";
import { inputExpired } from "../input/retention.ts";
import { InputAttention, deliveryFinished } from "../input/model.ts";
import { ResourceRefSchema } from "../topic/ref.ts";
import { isRootTopic } from "../topic/boundary.ts";
import { deliveryInUse, requireTopic } from "../topic/ownership.ts";
import { ReceiptSchema } from "../input/receipt.ts";
import { compatibleMembers, membersInTransaction, unclaimed, validateMemberRoots } from "./members.ts";
import { BATCH_TYPE, batchFinished, type Batch, type BatchSpec, type BatchStatus } from "./model.ts";

function canEvict(batch: Batch, context: ResourceValidationContext) {
  return batchFinished(batch) && !deliveryInUse(batch.spec.topic.uid, batch.status.assess?.executionId, context)
    && membersInTransaction(context, batch).every(i => deliveryFinished(i.status.assess));
}
export const BatchDefinition: ResourceDefinition<BatchSpec, BatchStatus> = {
  type: BATCH_TYPE, indexVersion: 2,
  schema: { spec: z.object({ topic: ResourceRefSchema, attention: z.literal(InputAttention.Normal), oldestAt: z.iso.datetime() }).strict(),
    status: z.object({ phase: z.enum(["preparing", "ready", "running", "completed", "failed", "cancelled"]), assess: ReceiptSchema.optional() }).strict() },
  validator: {
    create(batch, context) {
      if (batch.metadata.namespace !== "v1") throw new Error("Batch uses the Personal global namespace");
      if (!isRootTopic(requireTopic(batch.spec.topic, context))) throw new Error("Only a domain root can own a Batch");
      if (batch.status.phase !== "preparing" || batch.status.assess) throw new Error("Batch must be created preparing");
    },
    update(previous, current, context) {
      if (!isDeepStrictEqual(previous.spec, current.spec)) throw new Error("Batch scheduling scope is immutable");
      if (batchFinished(previous) && !isDeepStrictEqual(previous.status, current.status)) throw new Error("Batch is already terminal");
      const transitions: Record<BatchStatus["phase"], readonly string[]> = { preparing: ["ready", "cancelled"], ready: ["running", "cancelled"], running: ["ready", "completed", "failed"], completed: [], failed: [], cancelled: [] };
      if (previous.status.phase !== current.status.phase && !transitions[previous.status.phase].includes(current.status.phase)) throw new Error("Invalid Batch transition");
      if (previous.status.phase === "running" && current.status.phase !== "ready" && previous.status.assess?.executionId !== current.status.assess?.executionId) throw new Error("Batch execution is immutable");
      const members = membersInTransaction(context, current);
      if (previous.status.phase === "preparing" && current.status.phase === "ready") {
        if (!compatibleMembers(current, members) || members.some(i => !unclaimed(i))) throw new Error("Batch members unavailable or incompatible");
        validateMemberRoots(current, members, context);
      }
      if (previous.status.phase === "ready" && current.status.phase === "running") {
        if (!members.length || members.some(i => !unclaimed(i) || inputExpired(i))) throw new Error("Batch members unavailable for admission");
        validateMemberRoots(current, members, context);
        if (!current.status.assess?.executionId || !current.status.assess?.startedAt || requireTopic(current.spec.topic, context).status.execution?.id !== current.status.assess?.executionId)
          throw new Error("Batch admission requires its Chief execution");
      }
      if (current.status.phase === "ready" && current.status.assess?.executionId) throw new Error("Ready Batch cannot have an execution");
      if (["completed", "cancelled"].includes(current.status.phase) && !current.status.assess?.completedAt)
        throw new Error("Batch completion requires a terminal receipt");
      if (current.status.phase === "failed" && (!current.status.assess?.lastError || !current.status.assess.errorAt)) throw new Error("Failed Batch requires error evidence");
      if (current.status.phase === "cancelled" && current.status.assess?.result?.disposition !== "cancelled"
        || current.status.phase === "failed" && (current.status.assess?.completedAt || current.status.assess?.retryable))
        throw new Error("Batch phase and delivery outcome must agree");
      if (!batchFinished(current) && deliveryFinished(current.status.assess)) throw new Error("Open Batch cannot have a terminal delivery receipt");
    },
    delete(batch, context) { if (!canEvict(batch, context)) throw new Error("Finish Batch and project member receipts before deleting it"); },
  },
  indexes: { uid: r => [r.metadata.uid], topic: r => [r.spec.topic.uid],
    open: r => !r.metadata.deletionTimestamp && !batchFinished(r) ? [r.spec.topic.uid] : [],
    active: r => !r.metadata.deletionTimestamp && r.status.phase === "running" ? [r.spec.topic.uid] : [],
    deliveryExecution: r => r.status.assess?.executionId ? [r.status.assess?.executionId] : [] },
  orderedIndexes: { ready: r => !r.metadata.deletionTimestamp && r.status.phase === "ready" && !r.status.assess?.errorAt
    ? [{ value: r.spec.topic.uid, order: r.spec.oldestAt }] : [],
    retry: r => !r.metadata.deletionTimestamp && r.status.phase === "ready" && r.status.assess?.errorAt
      ? [{ value: r.spec.topic.uid, order: r.status.assess.errorAt }] : [] },
  retention: { collectOnRelease: true, releasedAt: r => r.status.assess?.completedAt ?? r.status.assess?.errorAt, canEvict,
    references: r => batchFinished(r) ? [] : [r.spec.topic.uid] },
  printer: { describe: r => `Batch ${r.metadata.name} (${r.status.phase})\nTopic: ${r.spec.topic.name}\nAttention: ${r.spec.attention}\nOldest input: ${r.spec.oldestAt}\n${r.status.assess?.result?.summary ?? r.status.assess?.lastError ?? ""}`,
    summarize: r => `Batch ${r.metadata.name}: ${r.status.phase}` },
};
