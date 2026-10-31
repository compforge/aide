import { isDeepStrictEqual } from "node:util";
import { PERSON_TYPE, type PersonResource } from "../person/model.ts";
import type { PluginContext, ReconcileRequest } from "@compforge/aide-plugin";
import { OUTPUT_TYPE, type Output, type OutputReconcileResult } from "./model.ts";

/** @spec Output uses the shared per-resource serialized queue and restart recovery. Channels cannot send unchecked intent. */
export function registerOutputs(context: PluginContext): void {
  // Policy changes wake waiting Outputs; an old deadline never overrides a newly relaxed policy.
  const pending = async (uid: string) => {
    const requests: ReconcileRequest[] = [];
    let continuation: string | undefined;
    do {
      const page = await context.resources.page(OUTPUT_TYPE, { limit: 100, consistency: "live",
        matchIndex: { name: "pendingReceiver", value: uid }, ...(continuation ? { continue: continuation } : {}) });
      requests.push(...page.items.map(r => ({ name: r.metadata.name, namespace: r.metadata.namespace })));
      continuation = page.metadata.continue || undefined;
    } while (continuation);
    return requests;
  };
  context.controllers.register({ resourceType: OUTPUT_TYPE, maxConcurrency: 2,
    watches: [{ resourceType: PERSON_TYPE, handler: {
      create: async () => [], delete: ({ object }) => pending(object.metadata.uid),
      update: async ({ oldObject, newObject }) => {
        const before = oldObject as PersonResource, after = newObject as PersonResource;
        return !isDeepStrictEqual(before.spec.delivery, after.spec.delivery) || before.metadata.deletionTimestamp !== after.metadata.deletionTimestamp
          ? pending(after.metadata.uid) : [];
      },
    } }],
    reconcile: async (execution, output: Readonly<Output>) => {
      if (output.metadata.deletionTimestamp || !["pending", "sending"].includes(output.status.phase)) return;
      const result = await execution.verbs.action<OutputReconcileResult>("reconcile_output", { id: output.metadata.name });
      if (result.state !== "success") throw new Error("Output reconcile did not complete");
      // Errors use runtime backoff; frequency waits use the normal due queue.
      return result.value;
    } });
}
