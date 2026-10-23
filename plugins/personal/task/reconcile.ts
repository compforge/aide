import { assignmentWatch, cancelAssignments, resourceRef } from "../input/state.ts";
import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { TASK_TYPE, type TaskSpec, type TaskResource } from "./model.ts";
import type { WorkStatus } from "../model.ts";
import { consumeWorkInputs, workCompletionWatch } from "../work-input.ts";
import { executeWork, recordOutcome, scheduledReconcile } from "../execution.ts";

/** @spec Task completion ends the finite goal; wait may still schedule a continuation.
 * @link docs/plugin/personal.md
 */
export async function reconcileTask(context: PluginContext, execution: ReconcileContext, resource: TaskResource) {
  if (resource.metadata.deletionTimestamp) { await cancelAssignments(context.resources, resourceRef(resource), "handle"); return; }
  const current = await consumeWorkInputs(context, resource);
  if (!current) return;
  const completed = await executeWork(context, execution, current);
  if (completed) await recordOutcome(context, current, completed, (current) => {
    current.status = "done"; current.nextAt = null;
  });
  return scheduledReconcile(context, resource);
}

export function registerTasks(context: PluginContext): void {
  context.controllers.register<TaskSpec, WorkStatus>({
    resourceType: TASK_TYPE, watches: [assignmentWatch("handle", "Task"), workCompletionWatch(TASK_TYPE)],
    reconcile: (execution, resource) => reconcileTask(context, execution, resource),
  });
}
