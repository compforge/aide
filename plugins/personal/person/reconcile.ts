import type { PluginContext } from "@compforge/aide-plugin";
import { PERSON_TYPE } from "./model.ts";

/** Person has no external cleanup; the standard deletion lifecycle can finalize immediately. */
export function registerPersons(context: PluginContext): void {
  context.controllers.register({ resourceType: PERSON_TYPE, reconcile: async () => {} });
}
