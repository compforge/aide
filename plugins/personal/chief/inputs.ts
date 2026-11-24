import type { ResourceClient } from "@compforge/aide-plugin";
import { assessBatch } from "../batch/assess.ts";
import { batchById } from "../batch/members.ts";
import { inputPreview } from "../input/prompt.ts";
import type { Input } from "../input/state.ts";
import type { TopicResource } from "../topic/model.ts";
import { assessInput, type AssessInput } from "./assess.ts";

/** @spec Chief addresses each sealed group once. Original material IDs identify evidence.
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

export async function assessChiefInput(resources: ResourceClient, topic: TopicResource, executionId: string, args: AssessInput, callId: string) {
  const batch = await batchById(resources, args.inputId);
  if (!batch) return assessInput(resources, topic, executionId, args, callId);
  if (args.curatedNotes?.length) throw new Error("Only aide:curate may acknowledge Notes");
  await assessBatch(resources, topic, executionId, { batchId: args.inputId, summary: args.summary }, callId);
  return { assessed: args.inputId };
}
