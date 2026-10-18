import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { ROUTINE_TYPE, type RoutineSpec, type RoutineResource, type WorkStatus } from "./resources.ts";
import { executeWork, recordOutcome, scheduledReconcile } from "./execution.ts";
import { nextOccurrence } from "./model.ts";

/** @spec Routine completion ends one occurrence and schedules the next; event-only routines remain subscribed.
 * @link docs/plugin/personal.md
 */
export async function reconcileRoutine(context: PluginContext, execution: ReconcileContext, resource: RoutineResource) {
  if (resource.metadata.deletionTimestamp) return;
  const completed = await executeWork(context, execution, resource);
  if (completed) await recordOutcome(context, resource, completed, (current) => {
    current.status = "scheduled"; current.nextAt = nextOccurrence(current.trigger, new Date());
  });
  return scheduledReconcile(context, resource);
}

export function registerRoutines(context: PluginContext): void {
  context.controllers.register<RoutineSpec, WorkStatus>({
    resourceType: ROUTINE_TYPE,
    reconcile: (execution, resource) => reconcileRoutine(context, execution, resource),
  });
}
