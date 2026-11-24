import { inputPreview } from "../input/prompt.ts";
import type { Input } from "../input/state.ts";

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
