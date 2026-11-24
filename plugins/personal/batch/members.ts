import type { ResourceReader, ResourceValidationContext } from "@compforge/aide-plugin";
import { INPUT_TYPE, InputAttention, deliveryFinished, inputAttention, isInternalInput, type InputSpec, type InputStatus } from "../input/model.ts";
import type { Input } from "../input/state.ts";
import { inputExpired } from "../input/retention.ts";
import { requireTopic } from "../topic/ownership.ts";
import { isProcessingRoot } from "../topic/boundary.ts";
import { BATCH_TYPE, type Batch, type BatchSpec, type BatchStatus } from "./model.ts";

/** Compatibility preserves provenance and authority without copying them into Batch. */
export function batchKey(input: Input): string {
  const s = input.spec;
  return JSON.stringify([s.origin, s.originId, inputAttention(s), input.status.topic?.uid, s.source, s.sender,
    s.originRef, s.relation, s.sensitivity, s.visibility, s.timezone, s.handoff]);
}
export const unclaimed = (input: Input) => !input.metadata.deletionTimestamp && !inputExpired(input)
  && !!input.status.assess && !deliveryFinished(input.status.assess) && !input.status.assess.executionId;
export async function batchById(resources: ResourceReader, uid: string) {
  return (await resources.page<BatchSpec, BatchStatus>(BATCH_TYPE, { matchIndex: { name: "uid", value: uid }, limit: 1 })).items[0];
}
export async function batchMembers(resources: ResourceReader, batch: Batch): Promise<readonly Input[]> {
  return (await resources.page<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "batch", value: batch.metadata.uid }, limit: 11 })).items;
}
export function membersInTransaction(context: ResourceValidationContext, batch: Batch) {
  return context.page<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "batch", value: batch.metadata.uid }, limit: 11 }).items;
}
export function compatibleMembers(batch: Batch, members: readonly Input[]): boolean {
  const first = members[0];
  return !!first && members.length <= 10 && !isInternalInput(first.spec) && !first.spec.handoff
    && batch.spec.oldestAt === members.map(i => i.metadata.creationTimestamp).sort()[0]
    && members.every(i => inputAttention(i.spec) === InputAttention.Deferred)
    && members.every(i => !i.metadata.deletionTimestamp && !inputExpired(i) && batchKey(i) === batchKey(first)
      && i.status.assess?.topic?.uid === batch.spec.topic.uid);
}
export function validateMemberRoots(batch: Batch, members: readonly Input[], context: ResourceValidationContext) {
  for (const member of members) {
    let root = requireTopic(member.status.topic, context);
    const seen = new Set<string>();
    while (!isProcessingRoot(root) && root.spec.parentRef) {
      if (seen.has(root.metadata.uid)) throw new Error("Topic parent cycle");
      seen.add(root.metadata.uid); root = requireTopic(root.spec.parentRef, context);
    }
    if (root.metadata.uid !== batch.spec.topic.uid) throw new Error("Batch processing assignment changed");
  }
}
