import { inputPreview } from "../input/prompt.ts";
import { assignmentWatch, cancelAssignments, resourceRef } from "../input/state.ts";
import type { PluginContext, ReconcileContext, Watch } from "@compforge/aide-plugin";
import { ROUTINE_TYPE, type RoutineSpec, type RoutineStatus, type RoutineResource } from "./model.ts";
import { consumeWorkInputs } from "../work-input.ts";
import { finalizeExecution, nextInput, runInput, submitPending } from "../loop.ts";
import { routinePolicy } from "./config.ts";

async function cleanup(context: PluginContext, execution: ReconcileContext, routine: Readonly<RoutineResource>) {
  if (routine.status.agent?.sessionId) {
    const closed = await execution.verbs.harness({ operation: "close", ...routine.status.agent, sessionId: routine.status.agent.sessionId, timeoutMs: 30_000 });
    if (closed.state !== "success" || closed.value.outcome !== "accepted") throw new Error("Routine native session is still busy or could not close");
  }
  await cancelAssignments(context.resources, resourceRef(routine));
}
const loopWatch: Watch = { resourceType: ROUTINE_TYPE, handler: { create: async () => [], delete: async () => [], update: async ({ oldObject, newObject }) => {
  const a = oldObject as RoutineResource, b = newObject as RoutineResource;
  return a.status.execution?.id !== b.status.execution?.id || a.status.status !== b.status.status
    ? [{ name: b.metadata.name, namespace: b.metadata.namespace }] : [];
} } };

/** Intake stays runnable while the agent waits for inference. */
export async function reconcileRoutineIntake(context: PluginContext, execution: ReconcileContext, routine: Readonly<RoutineResource>) {
  if (routine.metadata.deletionTimestamp) return cleanup(context, execution, routine);
  const updated = await consumeWorkInputs(context, routine) as RoutineResource | undefined;
  if (!updated || ["paused", "uncertain", "invalid_result"].includes(updated.status.status)) return;
  return submitPending(context, execution, updated);
}

/**
 * @spec An idle Routine releases its agent while the resource and its future trigger remain durable.
 * @link docs/personal/routine.md
 * @case tests/routine-agent.test.ts
 */
export async function reconcileRoutine(context: PluginContext, execution: ReconcileContext, initial: Readonly<RoutineResource>) {
  if (initial.metadata.deletionTimestamp) return cleanup(context, execution, initial);
  if (initial.status.execution) {
    await finalizeExecution(context, initial, initial.status.execution.id);
    return { requeueAfterMs: 1 };
  }
  let routine = await consumeWorkInputs(context, initial) as RoutineResource | undefined;
  if (!routine) return;
  const blocked = ["paused", "uncertain", "invalid_result"].includes(routine.status.status);
  const input = await nextInput(context.resources, routine);
  const due = routine.status.status === "scheduled" && !!routine.status.nextAt && Date.parse(routine.status.nextAt) <= Date.now();
  if (!blocked && (input || due)) {
    routine = await context.resources.patchStatus(routine, { status: "running", nextAt: null, idleSince: null, agentStoppedAt: null });
    const prompt = `Use the current resource context for your entrusted work; read_routine, read_input and read_topic supply missing or truncated evidence. Verify existing effects before handling failed inputs.
Activation: ${JSON.stringify({ routineId: routine.metadata.name, topicId: routine.spec.topicId, inputId: input?.metadata.name, kind: input ? "input" : "timer" })}
${input ? inputPreview(input) : ""}
Report handled inputs and progress using report_routine; use say for useful user communication.`;
    await runInput(context, execution.withContext({ topicId: routine.spec.topicId, routineId: routine.metadata.name }), routine, "routine", prompt, input?.metadata.name);
    return { requeueAfterMs: 1 };
  }
  if (routine.status.status === "running") {
    await context.resources.patchStatus(routine, { status: "uncertain" });
    return;
  }
  const policy = routinePolicy(context.instance.config.routine);
  if (!routine.status.idleSince) routine = await context.resources.patchStatus(routine, { idleSince: new Date().toISOString() });
  const untilTimer = !blocked && routine.status.status === "scheduled" && routine.status.nextAt ? Math.max(1, Date.parse(routine.status.nextAt) - Date.now()) : Infinity;
  if (!routine.status.agentStoppedAt) {
    const remaining = Date.parse(routine.status.idleSince!) + policy.agentIdleMs - Date.now();
    if (remaining > 0) return { requeueAfterMs: Math.min(remaining, untilTimer) };
    if (routine.status.agent?.sessionId) {
      const closed = await execution.verbs.harness({ operation: "close", ...routine.status.agent, sessionId: routine.status.agent.sessionId, timeoutMs: 30_000 });
      if (closed.state !== "success" || closed.value.outcome !== "accepted") throw new Error("Could not release idle Routine agent");
    }
    routine = await context.resources.patchStatus(routine, { agentStoppedAt: new Date().toISOString() });
    context.logger.info("Idle Routine agent stopped", { attributes: { routineId: routine.metadata.name, sessionId: routine.status.agent?.sessionId ?? null } });
  }
  if (Number.isFinite(untilTimer)) return { requeueAfterMs: untilTimer };
  // The responsibility remains subscribed even after its native handle is released.
}
export function registerRoutines(context: PluginContext): void {
  const watches = [assignmentWatch("handle", "Routine"), loopWatch];
  context.controllers.register<RoutineSpec, RoutineStatus>({ resourceType: ROUTINE_TYPE, watches, reconcile: (execution, routine) => reconcileRoutineIntake(context, execution, routine) });
  context.controllers.register<RoutineSpec, RoutineStatus>({ name: "agent", resourceType: ROUTINE_TYPE, watches, maxConcurrency: 4, reconcile: (execution, routine) => reconcileRoutine(context, execution, routine) });
}
