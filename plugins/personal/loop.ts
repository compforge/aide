import { inputExpired } from "./input/retention.ts";
import { readyBusinessInputs } from "./input/scheduling.ts";
import { topicPolicy } from "./topic/config.ts";
import { asHarnessError } from "@compforge/aide-plugin";
import { invalidateAssignment } from "./input/assignment.ts";
import { commitStatus } from "./status.ts";
import { z } from "zod";
import { prepareAgent, saveAgent } from "./session.ts";
import type { AgentStatus, HarnessError, PluginContext, ReconcileContext, Resource, ResourceClient } from "@compforge/aide-plugin";
import { assessmentFinished, InputAttention, INPUT_ORIGINS, inputAttention, isInternalInput, INPUT_TYPE, type InputSpec } from "./input/model.ts";
import { inputRef, pendingInputs, resourceRef, changeAttempt, changeAssessment, attemptOf, attemptPatch, type Input } from "./input/state.ts";
export { inputRef } from "./input/state.ts";
/** A persistent native session owns context; each invocation has a separate durable admission identity. */
export const LoopExecutionSchema = z.object({ id: z.string(), startedAt: z.string(), inputOrigin: z.enum(INPUT_ORIGINS).optional(), admissionRevision: z.number().int().nonnegative().optional(), observedGeneration: z.number().int().positive().optional() }).strict();
export type LoopExecution = z.infer<typeof LoopExecutionSchema>;
export interface LoopStatus { agent?: import("@compforge/aide-plugin").AgentStatus; execution?: LoopExecution | null }
export type LoopResource = Resource<unknown, LoopStatus>;
export const immediate = (input: InputSpec) => inputAttention(input) === InputAttention.Immediate;
const attentionOrder = { [InputAttention.Immediate]: 0, [InputAttention.Normal]: 1, [InputAttention.Deferred]: 2 };
/** @spec Deferral controls Chief activation, not Route classification or explicit Work handoff. */
export const canActivate = (input: InputSpec, owner: Pick<LoopResource, "kind">) =>
  owner.kind !== "Topic" || inputAttention(input) !== InputAttention.Deferred;
export function eligible(input: Input, owner: Readonly<LoopResource>): boolean {
  if (input.metadata.deletionTimestamp || inputExpired(input)) return false;
  if (owner.kind === "Topic") return !(owner.spec as { parentRef?: unknown }).parentRef
    && input.status.assess?.topic?.uid === owner.metadata.uid && !!input.status.assess && !assessmentFinished(input.status.assess) && !input.status.assess.executionId;
  const receipt = attemptOf(input, resourceRef(owner));
  if (receipt?.completedAt) return false;
  if (owner.kind === "Route") return !receipt?.executionId || (!!input.status.route?.nextAttemptAt && Date.parse(input.status.route.nextAttemptAt) <= Date.now());
  return !!receipt && !receipt.executionId && (!["Task", "Routine"].includes(owner.kind) || !!input.status.handle?.[owner.metadata.uid]?.appliedAt);
}
/** @spec Due retries compete by original arrival, independently of new input selection; a failed parent cannot starve. */
export async function nextInputs(resources: ResourceClient, owner: Readonly<LoopResource>, limit: number, businessOnly = false) {
  if (owner.kind === "Topic") {
    const selected: Input[] = [];
    const queues = businessOnly ? [InputAttention.Immediate, InputAttention.Normal, InputAttention.Deferred]
      : [InputAttention.Immediate, InputAttention.Normal, "aide:triage", "aide:organize", "aide:review", InputAttention.Deferred];
    for (const queue of queues) {
      const page = await resources.page<InputSpec, import("./input/model.ts").InputStatus>(INPUT_TYPE,
        { namespace: owner.metadata.namespace, matchIndex: { name: "assessReadyAttention", value: JSON.stringify([owner.metadata.uid, queue]) }, limit: Math.min(1000, limit - selected.length) });
      const items = page.items.filter(i => eligible(i, owner));
      if (queue.startsWith("aide:")) {
        if (selected.some(i => canActivate(i.spec, owner))) continue;
        if (items.length) return items.slice(0, 1);
      }
      selected.push(...items);
      if (selected.length >= limit) break;
    }
    return selected;
  }
  const inputs = await pendingInputs(resources, resourceRef(owner));
  return inputs.filter(i => eligible(i, owner)).sort((a, b) =>
    (owner.kind === "Route" ? 0 : attentionOrder[inputAttention(a.spec)] - attentionOrder[inputAttention(b.spec)])
    || a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp) || a.metadata.name.localeCompare(b.metadata.name)).slice(0, limit);
}

export async function nextInput(resources: ResourceClient, owner: Readonly<LoopResource>) {
  return (await nextInputs(resources, owner, 1))[0];
}

export async function retryDelay(resources: ResourceClient, owner: Readonly<LoopResource>) {
  const times = (await pendingInputs(resources, resourceRef(owner))).flatMap(i => i.status.route?.nextAttemptAt ? [Date.parse(i.status.route.nextAttemptAt)] : []);
  return times.length ? { requeueAfterMs: Math.max(1, Math.min(...times) - Date.now()) } : undefined;
}
export async function submitPending(context: PluginContext, execution: ReconcileContext, owner: Readonly<LoopResource>) {
  if (!owner.status.execution) return;
  let retry = false;
  if (owner.kind === "Topic") {
    const ready = await readyBusinessInputs(context.resources, owner as import("./topic/model.ts").TopicResource, topicPolicy(context.instance.config.topic));
    if (ready.inputs.length) {
      const urgent = ready.inputs.filter(i => immediate(i.spec));
      const inputs = urgent.length ? urgent : ready.inputs;
      const result = await execution.verbs.action<{ accepted: boolean; reason?: string }>("submit_topic", {
        inputId: inputs[0]!.metadata.name, inputIds: inputs.map(i => i.metadata.name), operation: urgent.length ? "steer" : "followUp",
      });
      if (result.state === "failure") throw new Error(`Agent Input admission failed: ${result.error ?? "unknown error"}`);
      context.logger.info("Chief business batch notification", { attributes: { topicUid: owner.metadata.uid,
        count: inputs.length, trigger: ready.reason ?? "business", oldestDeferredAt: ready.oldestAt ?? null,
        operation: urgent.length ? "steer" : "followUp", accepted: result.state === "success" && result.value.accepted } });
      return result.state === "success" && (result.value.accepted || ["not_running", "admission_conflict"].includes(result.value.reason ?? ""))
        ? { requeueAfterMs: 100 } : undefined;
    }
  }

  const batch = owner.kind === "Topic" ? (await nextInputs(context.resources, owner, 8)).filter(i => isInternalInput(i.spec))
    : await pendingInputs(context.resources, resourceRef(owner));
  for (const input of batch) {
    if (!eligible(input, owner) || !canActivate(input.spec, owner)) continue;
    const result = await execution.verbs.action<{ accepted: boolean; reason?: string }>(owner.kind === "Topic" ? "submit_topic" : "submit_input", { inputId: input.metadata.name, operation: immediate(input.spec) ? "steer" : "followUp" });
    if (result.state === "failure") throw new Error(`Agent Input admission failed: ${result.error ?? "unknown error"}`);
    if (result.state === "success" && !result.value.accepted && ["not_running", "admission_conflict"].includes(result.value.reason ?? "")) retry = true;
  }
  return retry || (owner.kind === "Topic" && batch.length === 8 && batch.some(i => canActivate(i.spec, owner))) ? { requeueAfterMs: 100 } : undefined;
}
/** @spec Only the owning Reconcile invokes its Agent. All automatic input paths persist their admission before dispatch; version conflicts never dispatch stale batches. */
export async function runInput(context: PluginContext, execution: ReconcileContext, owner: Readonly<LoopResource>, target: string, prompt: string, inputId?: string, batchIds: readonly string[] = []) {
  const current = await context.resources.get<unknown, LoopStatus>(resourceRef(owner));
  if (!current || current.metadata.deletionTimestamp || current.status.execution) return;
  if (current.kind === "Topic" && (current.spec as { parentRef?: unknown }).parentRef) return;
  const inputIds = [...new Set([...(inputId ? [inputId] : []), ...batchIds])];
  if (inputIds.length > 20) throw new Error("Agent admission batch exceeds 20 Inputs");
  const inputs = await Promise.all(inputIds.map(id => context.resources.get<InputSpec, import("./input/model.ts").InputStatus>(inputRef(id))));

  if (inputs.some(input => !input || !eligible(input, current))) return;
  if (current.kind === "Topic" && inputs.some(input => input && isInternalInput(input.spec))
    && inputs.length !== 1) throw new Error("Chief maintenance admits exactly one Input origin");
  const startedAt = new Date().toISOString();
  try {
    await commitStatus(context.resources, [
      { operation: "patchStatus", resource: current, patch: { execution: { id: execution.executionId, startedAt, ...(inputs[0] ? { inputOrigin: inputs[0].spec.origin } : {}), admissionRevision: 0, observedGeneration: current.metadata.generation },
        ...(current.kind === "Topic" ? { ...(inputs[0]?.spec.origin === "aide:review" ? { notifiedWeaveRevision: (owner.status as import("./topic/model.ts").TopicStatus).weaveRevision ?? 0 } : {}), lastError: null } : {}) } },
      ...inputs.map(input => ({ operation: "patchStatus" as const, resource: input!, patch: attemptPatch(input!, resourceRef(current), {
        executionId: execution.executionId, agent: undefined, startedAt, lastError: undefined, errorAt: undefined, retryable: undefined, nextAttemptAt: undefined,
        ...(current.kind === "Route" ? { attempts: (input!.status.route?.attempts ?? 0) + 1 } : {}) }) })),
    ]);
  } catch (error) {
    // Reconcile reselects the remaining inputs and rebuilds its prompt after a competing claim.
    if (current.kind === "Topic" && /processing assignment changed/.test(String(error))) {
      for (const input of inputs) {
        const latest = await context.resources.get<InputSpec, import("./input/model.ts").InputStatus>(inputRef(input!.metadata.name));
        if (latest) await invalidateAssignment(context, latest);
      }
      return;
    }
    if (current.kind === "Topic" && /version conflict/.test(String(error))) return;
    throw error;
  }
  context.logger.info("Agent input admitted", { attributes: { resourceUid: current.metadata.uid, inputId: inputId ?? "timer", inputIds, executionId: execution.executionId } });
  let completed = false;
  let agent: AgentStatus | undefined;
  let failure: HarnessError | undefined;
  let streaming = false;
  let error = "Agent ended without confirming input completion";
  try {
    agent = await prepareAgent(context.resources, execution, current, target);
    for (const input of current.kind === "Topic" ? inputs as Input[] : []) await changeAssessment(context.resources, input, execution.executionId, { agent });
    for (const id of current.kind === "Topic" ? [] : inputIds) await changeAttempt(context.resources, id, resourceRef(current), receipt =>
      receipt?.executionId === execution.executionId && !receipt.completedAt ? { agent } : {});
    if (current.kind === "Topic" && inputs.some(input => input?.spec.origin === "channel" && immediate(input.spec))) {
      const stream = await execution.verbs.action<{ streaming: boolean }>("begin_output_stream", { inputIds });
      if (stream.state !== "success") throw new Error("Could not establish Chief output stream");
      streaming = stream.value.streaming;
      if (streaming) prompt += "\nA live Output is already bound to this Immediate Input. Your agent events are written to its Stream. Before finishing, call cite_output for all Notes used by this reply; external new facts need a classified Note first. Write the reply directly in assistant text; do not call say for this same reply. Use say only for a separately intended communication. Do not emit an internal final acknowledgement.";
    }
    const result = await execution.verbs.harness({ ...agent, title: current.kind === "Route" ? "Route" : current.kind === "Topic" ? target === "gate" ? "Gate" : "Chief" : current.kind, prompt, timeoutMs: 172800_000 });
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
/**
 * @spec Admission evidence survives completion of the invocation and restart; unknown effects never automatically replay.
 * @why Chief idle time starts after every execution, including failure or recovery; missed timer checks never force continuation.
 * @spec Internal execution completion preserves review backoff; Topic reconciliation owns material progress and no-op outcomes.
 * @spec Final compaction failure releases only the matching binding with its execution; future admission independently creates an Agent.
 * @why This is a Personal fallback, not a verdict that native history is corrupt; failed Inputs and native files remain evidence.
 * @link docs/harness/pi.md#压缩与失败恢复
 * @case tests/input-admission.test.ts
 * @case tests/topic-review.test.ts
 */
export async function finalizeExecution(context: Pick<PluginContext, "resources" | "logger">, owner: Readonly<LoopResource>, executionId: string,
  error = "Previous execution interrupted; inspect existing effects before continuing", failure?: HarnessError) {
  const compactionFailed = failure?.code === "harness_compaction_failed";
  for (let n = 0; ; n++) {
    const latest = await context.resources.get<unknown, LoopStatus>(resourceRef(owner));
    if (!latest || latest.metadata.uid !== owner.metadata.uid || latest.status.execution?.id !== executionId) return;
    const released = compactionFailed && failure.agent?.sessionId && latest.status.agent?.harness === failure.agent.harness
      && latest.status.agent.sessionId === failure.agent.sessionId ? latest.status.agent : undefined;
    const unfinished = latest.kind === "Topic"
      ? await context.resources.list<import("./input/model.ts").InputSpec, import("./input/model.ts").InputStatus>(INPUT_TYPE, { matchIndex: { name: "assessExecution", value: executionId } })
      : (await pendingInputs(context.resources, resourceRef(latest))).filter(i => attemptOf(i, resourceRef(latest))?.executionId === executionId);
    const suspended = new Set(!error && latest.kind === "Topic" && (latest.status.execution.admissionRevision ?? 0) > 0
      ? unfinished.filter(i => isInternalInput(i.spec)).map(i => i.metadata.name) : []);
    const failed = unfinished.filter(i => !suspended.has(i.metadata.name));
    const at = new Date().toISOString();
    try {
      await commitStatus(context.resources, [
        ...unfinished.map(i => ({ operation: "patchStatus" as const, resource: i, patch: latest.kind === "Topic" ? { assess: { ...i.status.assess,
          ...(suspended.has(i.metadata.name)
            ? { executionId: undefined, agent: undefined, startedAt: undefined, deliveryId: undefined, lastError: undefined, errorAt: undefined, retryable: undefined }
            : { lastError: error || "Chief ended without confirming input completion", errorAt: at }) } } : attemptPatch(i, resourceRef(latest), receipt => receipt?.executionId !== executionId || receipt.completedAt ? {} : { lastError: error, errorAt: at, retryable: !compactionFailed,
          ...(latest.kind === "Route" && !compactionFailed ? { nextAttemptAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(i.status.route?.attempts ?? 1, 8))).toISOString() } : {}) }) })),
        { operation: "patchStatus", resource: latest, patch: { execution: null, ...(released ? { agent: undefined } : {}), ...(latest.kind === "Topic" ? { idleSince: at, lastError: error || null, reviewCheckedAt: null, ...(latest.status.execution.inputOrigin && !isInternalInput({ origin: latest.status.execution.inputOrigin })
            ? { idleReviewCount: 0 } : {}), idleReviewReset: null } : {}), ...(["Task", "Routine"].includes(latest.kind) ? {
          lastExecutionId: executionId,
          ...(!compactionFailed && (unfinished.length || (latest.status as import("./work-status.ts").WorkAgentStatus).lastExecutionId !== executionId)
            ? { recovery: { reason: "ExecutionUncertain", message: error || "Execution ended without a business receipt" } } : {}),
        } : {}) } },
      ]);
      if (latest.kind === "Topic" && error) context.logger.warn("Chief execution failed", { attributes: { topicUid: latest.metadata.uid, executionId, error } });
      if (suspended.size) context.logger.info("Chief interrupted maintenance returned to pending", { attributes: {
        topicUid: latest.metadata.uid, executionId, inputIds: [...suspended],
      } });
      if (failed.length) context.logger.warn(latest.kind === "Topic" ? "Chief input assessments failed" : compactionFailed ? "Agent inputs failed" : "Agent inputs await recovery", { attributes: { resourceUid: latest.metadata.uid, executionId,
        inputIds: failed.map(i => i.metadata.name), recovery: compactionFailed || latest.kind === "Topic" ? "none" : latest.kind === "Route" ? "retry" : "inspect", error } });
      if (released) context.logger.warn("Agent binding released after compaction failure", { attributes: { resourceUid: latest.metadata.uid,
        executionId, harness: released.harness, sessionId: released.sessionId ?? null, code: failure!.code, error: failure!.message } });
      return released;
    } catch (cause) { if (n >= 8 || !/version conflict/.test(String(cause))) throw cause; }
  }
}
