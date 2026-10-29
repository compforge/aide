import type { PluginContext } from "@compforge/aide-plugin";
import { NOTE_TYPE } from "./model.ts";
/** Explicit deletion has no external cleanup; capacity eviction remains independent of reconciliation. */
export function registerNotes(context: PluginContext): void {
  context.controllers.register({ resourceType: NOTE_TYPE, reconcile: async () => {} });
}
