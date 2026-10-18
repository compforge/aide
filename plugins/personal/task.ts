import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { TASK_TYPE, type TaskSpec, type TaskResource, type WorkStatus } from "./resources.ts";
import { executeWork, recordOutcome, scheduledReconcile } from "./execution.ts";

/** @spec Task completion ends the finite goal; wait may still schedule a continuation.
 * @link docs/runtime.md
 */
export async function reconcileTask(context: PluginContext, execution: ReconcileContext, resource: TaskResource) {
  if (resource.metadata.deletionTimestamp) return;
  const completed = await executeWork(context, execution, resource);
  if (completed) await recordOutcome(context, resource, completed, (current) => {
    current.status = "done"; current.nextAt = null;
  });
  return scheduledReconcile(context, resource);
}

export function registerTasks(context: PluginContext): void {
  context.controllers.register<TaskSpec, WorkStatus>({
    resourceType: TASK_TYPE,
    reconcile: (execution, resource) => reconcileTask(context, execution, resource),
  });
}
