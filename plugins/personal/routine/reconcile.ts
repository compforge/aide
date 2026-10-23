import { assignmentWatch, cancelAssignments, resourceRef } from "../input/state.ts";
import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { ROUTINE_TYPE, type RoutineSpec, type RoutineResource } from "./model.ts";
import { nextOccurrence, type WorkStatus } from "../model.ts";
import { consumeWorkInputs, workCompletionWatch } from "../work-input.ts";
import { executeWork, recordOutcome, scheduledReconcile } from "../execution.ts";

/** @spec Routine completion ends one occurrence and schedules the next; event-only routines remain subscribed.
 * @link docs/plugin/personal.md
 */
export async function reconcileRoutine(context: PluginContext, execution: ReconcileContext, resource: RoutineResource) {
  if (resource.metadata.deletionTimestamp) { await cancelAssignments(context.resources, resourceRef(resource), "handle"); return; }
  const current = await consumeWorkInputs(context, resource);
  if (!current) return;
  const completed = await executeWork(context, execution, current);
  if (completed) await recordOutcome(context, current, completed, (current) => {
    current.status = "scheduled"; current.nextAt = nextOccurrence(current.trigger, new Date());
  });
  return scheduledReconcile(context, resource);
}

export function registerRoutines(context: PluginContext): void {
  context.controllers.register<RoutineSpec, WorkStatus>({
    resourceType: ROUTINE_TYPE, watches: [assignmentWatch("handle", "Routine"), workCompletionWatch(ROUTINE_TYPE)],
    reconcile: (execution, resource) => reconcileRoutine(context, execution, resource),
  });
}
