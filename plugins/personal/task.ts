import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { TASK_TYPE, type TaskSpec, type TaskResource, type WorkStatus } from "./resources.ts";
import { consumeWorkInputs } from "./work-input.ts";
import { executeWork, recordOutcome, scheduledReconcile } from "./execution.ts";

/** @spec Task completion ends the finite goal; wait may still schedule a continuation.
 * @link docs/plugin/personal.md
 */
export async function reconcileTask(context: PluginContext, execution: ReconcileContext, resource: TaskResource) {
  if (resource.metadata.deletionTimestamp) return;
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
    resourceType: TASK_TYPE,
    reconcile: (execution, resource) => reconcileTask(context, execution, resource),
  });
}
