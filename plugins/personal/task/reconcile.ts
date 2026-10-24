import { assignmentWatch, cancelAssignments, resourceRef, pendingInputs } from "../input/state.ts";
import type { PluginContext, ReconcileContext, Watch } from "@compforge/aide-plugin";
import { TASK_TYPE, type TaskSpec, type TaskStatus, type TaskResource } from "./model.ts";
import { consumeWorkInputs } from "../work-input.ts";
import { finalizeExecution, nextInput, runInput, submitPending } from "../loop.ts";
import { taskPolicy } from "./config.ts";

async function cleanup(context: PluginContext, execution: ReconcileContext, task: Readonly<TaskResource>) {
  if (task.status.agent?.sessionId) {
    const closed = await execution.verbs.harness({ operation: "close", ...task.status.agent, sessionId: task.status.agent.sessionId, timeoutMs: 30_000 });
    if (closed.state !== "success" || closed.value.outcome !== "accepted") throw new Error("Task native session is still busy or could not close");
  }
  await cancelAssignments(context.resources, resourceRef(task), "handle");
}
const loopWatch: Watch = { resourceType: TASK_TYPE, handler: { create: async () => [], delete: async () => [], update: async ({ oldObject, newObject }) => {
  const a = oldObject as TaskResource, b = newObject as TaskResource;
  return a.status.execution?.id !== b.status.execution?.id || a.status.status !== b.status.status
    ? [{ name: b.metadata.name, namespace: b.metadata.namespace }] : [];
} } };

/** Intake stays runnable while the agent waits for inference. */
export async function reconcileTaskIntake(context: PluginContext, execution: ReconcileContext, task: Readonly<TaskResource>) {
  if (task.metadata.deletionTimestamp) return cleanup(context, execution, task);
  const updated = await consumeWorkInputs(context, task) as TaskResource | undefined;
  if (!updated || ["paused", "uncertain", "invalid_result"].includes(updated.status.status)) return;
  return submitPending(context, execution, updated);
}

/**
 * @spec deletionTimestamp permanently fences new assignments; idle retirement uses optimistic deletion.
 * @link docs/personal/task.md
 * @case tests/task-agent.test.ts
 */
export async function reconcileTask(context: PluginContext, execution: ReconcileContext, initial: Readonly<TaskResource>) {
  if (initial.metadata.deletionTimestamp) return cleanup(context, execution, initial);
  if (initial.status.execution) {
    await finalizeExecution(context, initial, initial.status.execution.id);
    return { requeueAfterMs: 1 };
  }
  let task = await consumeWorkInputs(context, initial) as TaskResource | undefined;
  if (!task) return;
  const blocked = ["paused", "uncertain", "invalid_result"].includes(task.status.status);
  const input = await nextInput(context.resources, task);
  const due = task.status.status === "scheduled" && !!task.status.nextAt && Date.parse(task.status.nextAt) <= Date.now();
  if (!blocked && (input || due)) {
    task = await context.resources.patchStatus(task, { status: "running", nextAt: null, idleSince: null, agentStoppedAt: null });
    const prompt = `Use the current resource context for your entrusted work; read_task, read_input and read_conv supply missing or truncated evidence. Verify existing effects before handling failed inputs.
Activation: ${JSON.stringify({ taskId: task.metadata.name, conversationId: task.spec.conversationId, inputId: input?.metadata.name, kind: input ? "input" : "timer" })}
Report handled inputs and progress using report_task; use say for useful user communication.`;
    await runInput(context, execution.withContext({ conversationId: task.spec.conversationId, taskId: task.metadata.name }), task, "task", prompt, input?.metadata.name);
    return { requeueAfterMs: 1 };
  }
  if (task.status.status === "running") {
    await context.resources.patchStatus(task, { status: "uncertain" });
    return;
  }
  const policy = taskPolicy(context.instance.config.task);
  if (!task.status.idleSince) task = await context.resources.patchStatus(task, { idleSince: new Date().toISOString() });
  const untilTimer = !blocked && task.status.status === "scheduled" && task.status.nextAt ? Math.max(1, Date.parse(task.status.nextAt) - Date.now()) : Infinity;
  if (!task.status.agentStoppedAt) {
    const remaining = Date.parse(task.status.idleSince!) + policy.agentIdleMs - Date.now();
    if (remaining > 0) return { requeueAfterMs: Math.min(remaining, untilTimer) };
    if (task.status.agent?.sessionId) {
      const closed = await execution.verbs.harness({ operation: "close", ...task.status.agent, sessionId: task.status.agent.sessionId, timeoutMs: 30_000 });
      if (closed.state !== "success" || closed.value.outcome !== "accepted") throw new Error("Could not release idle Task agent");
    }
    task = await context.resources.patchStatus(task, { agentStoppedAt: new Date().toISOString() });
    context.logger.info("Idle Task agent stopped", { attributes: { taskId: task.metadata.name, sessionId: task.status.agent?.sessionId ?? null } });
  }
  const pending = await pendingInputs(context.resources, resourceRef(task));
  if (Number.isFinite(untilTimer)) return { requeueAfterMs: untilTimer };
  if (blocked || pending.length || task.status.status === "waiting" || task.status.nextAt) return;
  const remaining = Date.parse(task.status.agentStoppedAt!) + policy.idleRetentionMs - Date.now();
  if (remaining > 0) return { requeueAfterMs: remaining };
  await context.resources.delete(TASK_TYPE, task.metadata.name, "v1", { uid: task.metadata.uid, resourceVersion: task.metadata.resourceVersion });
  context.logger.info("Idle Task deletion requested", { attributes: { taskId: task.metadata.name, taskUid: task.metadata.uid, idleSince: task.status.idleSince ?? null } });
}
export function registerTasks(context: PluginContext): void {
  const watches = [assignmentWatch("handle", "Task"), loopWatch];
  context.controllers.register<TaskSpec, TaskStatus>({ resourceType: TASK_TYPE, watches, reconcile: (execution, task) => reconcileTaskIntake(context, execution, task) });
  context.controllers.register<TaskSpec, TaskStatus>({ name: "agent", resourceType: TASK_TYPE, watches, maxConcurrency: 4, reconcile: (execution, task) => reconcileTask(context, execution, task) });
}
