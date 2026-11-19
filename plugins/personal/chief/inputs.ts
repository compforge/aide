import type { ResourceClient } from "@compforge/aide-plugin";
import { assessBatch } from "../batch/assess.ts";
import { batchById, batchMembers } from "../batch/members.ts";
import { inputPreview } from "../input/prompt.ts";
import type { Input } from "../input/state.ts";
import type { TopicResource } from "../topic/model.ts";
import { assessInput, type AssessInput } from "./assess.ts";

/** @spec Chief addresses each sealed group once. Original material IDs identify evidence and Work requests.
 * @link docs/personal/batch.md
 */
export function chiefInputs(inputs: readonly Input[]) {
  const groups = new Map<string, Input[]>();
  for (const input of inputs) {
    const id = input.status.batchId ?? input.metadata.name;
    const group = groups.get(id);
    if (group) group.push(input);
    else groups.set(id, [input]);
  }
  return groups;
}

export function chiefPreviews(inputs: readonly Input[], budget: number) {
  const perMaterial = Math.floor(budget / inputs.length);
  return Array.from(chiefInputs(inputs), ([inputId, materials]) => ({
    inputId, description: materials.map(input => inputPreview(input, perMaterial, !!input.status.batchId)).join("\n\n"),
  }));
}

type WorkRequest = NonNullable<AssessInput["workRequests"]>[number];
export type ChiefAssessment = Omit<AssessInput, "workRequests"> & {
  workRequests?: (WorkRequest & { sourceInputId?: string })[];
};

export async function assessChiefInput(resources: ResourceClient, topic: TopicResource, executionId: string, args: ChiefAssessment, callId: string) {
  const { inputId, summary, workRequests = [] } = args;
  const batch = await batchById(resources, inputId);
  if (batch) {
    const members = workRequests.length ? await batchMembers(resources, batch) : [];
    const requests = workRequests.map(({ sourceInputId, ...request }) => {
      const member = sourceInputId ?? (members.length === 1 ? members[0]!.metadata.name : undefined);
      if (!member) throw new Error("Supply sourceInputId for a Work request with multiple source materials");
      return { ...request, inputId: member };
    });
    await assessBatch(resources, topic, executionId, { batchId: inputId, summary, workRequests: requests }, callId);
    return { assessed: inputId };
  }
  const requests = workRequests.map(({ sourceInputId, ...request }) => {
    if (sourceInputId !== undefined && sourceInputId !== inputId) throw new Error("Work request source does not belong to this input");
    return request;
  });
  return assessInput(resources, topic, executionId, { inputId, summary, workRequests: requests }, callId);
}
