import { inputMessage, messagePrompt } from "../messages.ts";
import { isProcessingRoot } from "../topic/boundary.ts";
import { BATCH_TYPE, type Batch, type BatchSpec, type BatchStatus } from "../batch/model.ts";
import { asHarnessError } from "@compforge/aide-plugin";
import { invalidateAssignment } from "../input/assignment.ts";
import { commitStatus } from "../status.ts";
import { z } from "zod";
import { prepareAgent, saveAgent } from "./session.ts";
import type { AgentStatus, HarnessError, PluginContext, ReconcileContext, Resource } from "@compforge/aide-plugin";
import { deliveryFinished, INPUT_ORIGINS, isInternalInput, INPUT_TYPE, type InputSpec } from "../input/model.ts";
import { inputRef, pendingInputs, resourceRef, changeAttempt, changeDelivery, attemptOf, attemptPatch, type Input } from "../input/state.ts";
import { immediate, eligible } from "./input.ts";
export { inputRef } from "../input/state.ts";
/** A persistent native session owns context; each invocation has a separate durable admission identity. */
export const LoopExecutionSchema = z.object({ id: z.string(), startedAt: z.string(), inputOrigin: z.enum(INPUT_ORIGINS).optional(), admissionRevision: z.number().int().nonnegative().optional(), observedGeneration: z.number().int().positive().optional() }).strict();
export type LoopExecution = z.infer<typeof LoopExecutionSchema>;
export interface LoopStatus { agent?: import("@compforge/aide-plugin").AgentStatus; execution?: LoopExecution | null }
export type LoopResource = Resource<unknown, LoopStatus>;
/** @spec Role reconcilers select their work before entering this shared admission and execution lifecycle.
 * @spec Only the owning Reconcile invokes its Agent. All automatic input paths persist their admission before dispatch; version conflicts never dispatch stale batches. */
export async function runInput(context: PluginContext, execution: ReconcileContext, owner: Readonly<LoopResource>, target: string, activation: string | (import("@compforge/aide-plugin").ApplicationMessage & { content: string }), inputId?: string, additionalInputIds: readonly string[] = [], batch?: Batch) {
  const current = await context.resources.get<unknown, LoopStatus>(resourceRef(owner));
  if (!current || current.metadata.deletionTimestamp || current.status.execution) return;
  if (current.kind === "Topic" && !isProcessingRoot(current as import("../topic/model.ts").TopicResource)) return;
  const inputIds = [...new Set([...(inputId ? [inputId] : []), ...additionalInputIds])];
  if (inputIds.length > 20) throw new Error("Agent admission batch exceeds 20 Inputs");
  const inputs = await Promise.all(inputIds.map(id => context.resources.get<InputSpec, import("../input/model.ts").InputStatus>(inputRef(id))));

  if (inputs.some(input => !input || (batch ? input.status.batchId !== batch.metadata.uid || input.status.assess?.executionId || deliveryFinished(input.status.assess) : !eligible(input, current)))) return;
  if (batch && (current.kind !== "Topic" || batch.spec.topic.uid !== current.metadata.uid || batch.status.phase !== "ready")) return;
  if (current.kind === "Topic" && inputs.some(input => input && isInternalInput(input.spec))
    && inputs.length !== 1) throw new Error("Chief maintenance admits exactly one Input origin");
  const startedAt = new Date().toISOString();
  try {
    await commitStatus(context.resources, [
      { operation: "patchStatus", resource: current, patch: { execution: { id: execution.executionId, startedAt, ...(inputs[0] ? { inputOrigin: inputs[0].spec.origin } : {}), admissionRevision: 0, observedGeneration: current.metadata.generation },
        ...(current.kind === "Topic" ? { lastError: null } : {}) } },
      ...(batch ? [] : inputs).map(input => ({ operation: "patchStatus" as const, resource: input!, patch: attemptPatch(input!, resourceRef(current), {
        executionId: execution.executionId, agent: undefined, startedAt, lastError: undefined, errorAt: undefined, retryable: undefined, nextAttemptAt: undefined,
        ...(current.kind === "Route" ? { attempts: (input!.status.route?.attempts ?? 0) + 1 } : {}) }) })),
      ...(batch ? [{ operation: "patchStatus" as const, resource: batch, patch: { phase: "running", assess: { executionId: execution.executionId, startedAt } } }] : []),
    ]);
  } catch (error) {
    // Reconcile reselects the remaining inputs and rebuilds its prompt after a competing claim.
    if (current.kind === "Topic" && /processing assignment changed/.test(String(error))) {
      for (const input of inputs) {
        const latest = await context.resources.get<InputSpec, import("../input/model.ts").InputStatus>(inputRef(input!.metadata.name));
        if (latest) await invalidateAssignment(context, latest);
      }
      return;
    }
    if (current.kind === "Topic" && String(error).includes("Chief has queued business")) return { requeueAfterMs: 60_000 };
    if (current.kind === "Topic" && /Chief is dormant|version conflict/.test(String(error))) return;
    throw error;
  }
  context.logger.info("Agent input admitted", { attributes: { resourceUid: current.metadata.uid, inputId: inputId ?? "timer", inputIds, executionId: execution.executionId } });
  let prompt = typeof activation === "string" ? activation : activation.content;
  let completed = false;
  let agent: AgentStatus | undefined;
  let failure: HarnessError | undefined;
  let streaming = false;
  let error = "Agent ended without confirming input completion";
  try {
    agent = await prepareAgent(context.resources, execution, current, target);
    if (current.kind === "Topic" && current.status.agent?.sessionId !== agent.sessionId)
      context.logger.info("Topic agent session bound", { attributes: { topicUid: current.metadata.uid, harness: target,
        executionId: execution.executionId, previousSessionId: current.status.agent?.sessionId ?? null, sessionId: agent.sessionId! } });
    for (const input of current.kind === "Topic" && !batch ? inputs as Input[] : []) await changeDelivery(context.resources, input, execution.executionId, { agent });
    if (batch) {
      const admitted = await context.resources.get<BatchSpec, BatchStatus>(resourceRef(batch));
      if (admitted?.status.phase === "running") await commitStatus(context.resources, [{ operation: "patchStatus", resource: admitted, patch: { assess: { ...admitted.status.assess, agent } } }]);
    }
    for (const id of current.kind === "Topic" ? [] : inputIds) await changeAttempt(context.resources, id, resourceRef(current), receipt =>
      receipt?.executionId === execution.executionId && !receipt.completedAt ? { agent } : {});
    if (current.kind === "Topic" && !batch && inputs.some(input => input?.spec.origin === "channel" && immediate(input.spec))) {
      const stream = await execution.verbs.action<{ streaming: boolean }>("begin_output_stream", { inputIds: inputs.map(i => i!.metadata.name) });
      if (stream.state !== "success") throw new Error("Could not establish Chief output stream");
      streaming = stream.value.streaming;
      if (streaming) prompt += "\nA live Output is already bound to this Immediate Input. Your agent events are written to its Stream. Before finishing, call cite_output for all Notes used by this reply; external new facts need a classified Note first. Write the reply directly in assistant text; do not call say for this same reply. Use say only for a separately intended communication. Do not emit an internal final acknowledgement.";
    }
    const material = inputIds.length ? inputMessage(prompt, execution.executionId, inputs as Input[], batch?.metadata.uid) : activation;
    const request = typeof material === "string" ? { prompt } : messagePrompt(material);
    const result = await execution.verbs.harness({ ...agent, title: current.kind === "Route" ? "Route" : current.kind === "Topic" ? target === "gate" ? "Gate" : "Chief" : current.kind, ...request, timeoutMs: 172800_000 });
    completed = result.state === "success" && result.value.result.stopReason === "end_turn";
    if (result.agent?.sessionId) await saveAgent(context.resources, current, execution.executionId, result.agent);
    if (!completed) error = `Agent execution did not complete: ${result.state === "success" ? result.value.result.stopReason : result.state}`;
  } catch (cause) {
    failure = asHarnessError(cause, agent);
    error = failure?.message ?? String(cause);
    if (failure?.code !== "harness_compaction_failed" && failure?.agent?.sessionId) await saveAgent(context.resources, current, execution.executionId, failure.agent);
  }
  finally {
    try {
      if (streaming) {
        const closed = await execution.verbs.action("finish_output_stream", completed ? {} : { error });
        if (closed.state !== "success") throw new Error(`Could not close Chief output stream: ${closed.state === "failure" ? closed.error : closed.state}`);
      }
    } catch (cause) {
      completed = false;
      error = failure?.message ?? String(cause);
      context.logger.warn("Chief output stream cleanup failed", { attributes: { resourceUid: current.metadata.uid,
        executionId: execution.executionId, error: String(cause) } });
    }
    finally {
      const released = await finalizeExecution(context, current, execution.executionId, current.kind === "Topic" && completed ? "" : error, failure);
      if (released?.sessionId) {
        try {
          const closed = await execution.verbs.harness({ operation: "close", ...released, sessionId: released.sessionId, timeoutMs: 30_000 });
          if (closed.state !== "success" || closed.value.outcome !== "accepted") throw new Error(`Could not close failed Agent: ${closed.state}`);
        } catch (cause) {
          context.logger.warn("Failed Agent runtime cleanup failed", { attributes: { resourceUid: current.metadata.uid,
            executionId: execution.executionId, harness: released.harness, sessionId: released.sessionId, error: String(cause) } });
        }
      }
    }
  }
  return completed;
}
function incompleteDelivery(receipt: import("../input/model.ts").ProcessingReceipt | undefined, interrupted: boolean, at: string, error: string) {
  const uncertain = interrupted && !!receipt?.agent;
  return { ...receipt, executionId: uncertain ? receipt?.executionId : undefined, deliveryId: uncertain ? receipt?.deliveryId : undefined,
    lastError: uncertain ? "Chief delivery outcome unknown after interruption" : error || "Input did not reach Chief context",
    errorAt: at, retryable: !uncertain };
}
/**
 * @spec Retry an undelivered admission. An interrupted native session with unknown delivery requires inspection.
 * @why Chief idle time starts after every execution, including failure or recovery; missed timer checks never force continuation.
 * @spec Chief finalization never schedules maintenance; a delivered user message records its own receipt.
 * @spec Final compaction failure releases only the matching binding with its execution; future admission independently creates an Agent.
 * @why This is a Personal fallback, not a verdict that native history is corrupt; failed Inputs and native files remain evidence.
 * @link docs/harness/pi.md#压缩与失败恢复
 * @case tests/input-admission.test.ts
 * @case tests/topic-review.test.ts
 */
export async function finalizeExecution(context: Pick<PluginContext, "resources" | "logger">, owner: Readonly<LoopResource>, executionId: string,
  error?: string, failure?: HarnessError) {
  const interrupted = error === undefined;
  error ??= "Previous execution interrupted; inspect existing effects before continuing";
  const compactionFailed = failure?.code === "harness_compaction_failed";
  for (let n = 0; ; n++) {
    const latest = await context.resources.get<unknown, LoopStatus>(resourceRef(owner));
    if (!latest || latest.metadata.uid !== owner.metadata.uid || latest.status.execution?.id !== executionId) return;
    const released = compactionFailed && failure.agent?.sessionId && latest.status.agent?.harness === failure.agent.harness
      && latest.status.agent.sessionId === failure.agent.sessionId ? latest.status.agent : undefined;
    const unfinished = latest.kind === "Topic"
      ? (await context.resources.list<import("../input/model.ts").InputSpec, import("../input/model.ts").InputStatus>(INPUT_TYPE, { matchIndex: { name: "deliveryExecution", value: executionId } })).filter(i => !deliveryFinished(i.status.assess))
      : (await pendingInputs(context.resources, resourceRef(latest))).filter(i => attemptOf(i, resourceRef(latest))?.executionId === executionId);
    const batches = latest.kind === "Topic" ? (await context.resources.list<BatchSpec, BatchStatus>(BATCH_TYPE,
      { matchIndex: { name: "deliveryExecution", value: executionId } })).filter(batch => batch.status.phase === "running") : [];
    const at = new Date().toISOString();
    try {
      await commitStatus(context.resources, [
        ...unfinished.map(i => ({ operation: "patchStatus" as const, resource: i, patch: latest.kind === "Topic" ? { assess: incompleteDelivery(i.status.assess, interrupted, at, error) } : attemptPatch(i, resourceRef(latest), receipt => receipt?.executionId !== executionId || receipt.completedAt ? {} : { lastError: error, errorAt: at, retryable: !compactionFailed,
          ...(latest.kind === "Route" && !compactionFailed ? { nextAttemptAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(i.status.route?.attempts ?? 1, 8))).toISOString() } : {}) }) })),
        ...batches.map(batch => {
          const assess = incompleteDelivery(batch.status.assess, interrupted, at, error || "Batch did not reach Chief context");
          return { operation: "patchStatus" as const, resource: batch, patch: { phase: assess.retryable ? "ready" : "failed", assess } };
        }),
        { operation: "patchStatus", resource: latest, patch: { execution: null, ...(released ? { agent: undefined } : {}), ...(latest.kind === "Topic" ? { idleSince: at, lastError: error || null } : {}), ...(["Task", "Routine"].includes(latest.kind) ? {
          lastExecutionId: executionId,
          ...(!compactionFailed && (unfinished.length || (latest.status as import("../work/agent-status.ts").WorkAgentStatus).lastExecutionId !== executionId)
            ? { recovery: { reason: "ExecutionUncertain", message: error || "Execution ended without a business receipt" } } : {}),
        } : {}) } },
      ]);
      if (batches.length) context.logger.warn("Chief Batch delivery incomplete", { attributes: { resourceUid: latest.metadata.uid,
        executionId, batchIds: batches.map(batch => batch.metadata.uid), error: error || "Missing Batch delivery", interrupted } });
      if (latest.kind === "Topic" && error) context.logger.warn("Chief execution failed", { attributes: { topicUid: latest.metadata.uid, executionId, error } });
      if (unfinished.length) context.logger.warn(latest.kind === "Topic" ? "Chief Input delivery incomplete" : compactionFailed ? "Agent inputs failed" : "Agent inputs await recovery", { attributes: { resourceUid: latest.metadata.uid, executionId,
        inputIds: unfinished.map(i => i.metadata.name), ...(latest.kind === "Topic" ? { inspectInputIds: unfinished.filter(i => interrupted && i.status.assess?.agent).map(i => i.metadata.name) } : { recovery: latest.kind === "Route" && !compactionFailed ? "retry" : compactionFailed ? "none" : "inspect" }), error } });
      if (released) context.logger.warn("Agent binding released after compaction failure", { attributes: { resourceUid: latest.metadata.uid,
        executionId, harness: released.harness, sessionId: released.sessionId ?? null, code: failure!.code, error: failure!.message } });
      return released;
    } catch (cause) { if (n >= 8 || !/version conflict/.test(String(cause))) throw cause; }
  }
}
