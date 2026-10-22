import { type PluginContext } from "@compforge/aide-plugin";
import { OUTPUT_TYPE, type OutputSpec, type OutputStatus } from "../output/model.ts";
import type { Batch } from "./batch.ts";
/** @spec Handoff preserves who was addressed and where, as well as what was said; Outputs stay pinned until it commits. */
export async function batchOutputs(context: Pick<PluginContext, "resources" | "printers">, batch: Batch): Promise<string[]> {
  return Promise.all(batch.outputIds.map(async (id) => {
    const output = await context.resources.get<OutputSpec, OutputStatus>({ ...OUTPUT_TYPE, namespace: "v1", name: id });
    if (!output) throw new Error(`Batch Output missing: ${id}`);
    return context.printers.describe(output);
  }));
}
