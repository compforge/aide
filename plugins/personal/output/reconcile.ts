import type { PluginContext } from "@compforge/aide-plugin";
import { OUTPUT_TYPE, type Output } from "./model.ts";

/** @spec Output uses the shared per-resource serialized queue and restart recovery. Channels cannot send unchecked intent. */
export function registerOutputs(context: PluginContext): void {
  context.controllers.register({ resourceType: OUTPUT_TYPE, maxConcurrency: 2,
    reconcile: async (execution, output: Readonly<Output>) => {
      if (output.metadata.deletionTimestamp || !["pending", "sending"].includes(output.status.phase)) return;
      const result = await execution.verbs.action("reconcile_output", { id: output.metadata.name });
      if (result.state !== "success") throw new Error("Output reconcile did not complete");
      // Errors retry this resource through the runtime queue; delivery is terminal on success.
    } });
}
