import { commitStatus } from "./status.ts";
import { z } from "zod";
import { prepareAgent, saveAgent } from "./session.ts";
import type { PluginContext, ReconcileContext, Resource, ResourceClient } from "@compforge/aide-plugin";
import { InputAttention, inputAttention, INPUT_TYPE, type InputSpec } from "./input/model.ts";
import { inputRef, pendingInputs, resourceRef, changeAttempt, changeAssessment, attemptOf, attemptPatch, belongsToTopic, topicScope, type Input } from "./input/state.ts";
export { inputRef } from "./input/state.ts";
/** A persistent native session owns context; each invocation has a separate durable admission identity. */
export const LoopExecutionSchema = z.object({ id: z.string(), startedAt: z.string(), admissionRevision: z.number().int().nonnegative().optional(), observedGeneration: z.number().int().positive().optional() }).strict();
export type LoopExecution = z.infer<typeof LoopExecutionSchema>;
export interface LoopStatus { agent?: import("@compforge/aide-plugin").AgentStatus; execution?: LoopExecution | null }
export type LoopResource = Resource<unknown, LoopStatus>;
export const immediate = (input: InputSpec) => inputAttention(input) === InputAttention.Immediate;
const attentionOrder = { [InputAttention.Immediate]: 0, [InputAttention.Normal]: 1, [InputAttention.Deferred]: 2 };
/** @spec Deferral controls Chief activation, not Route classification or explicit Work handoff. */
export const canActivate = (input: InputSpec, owner: Pick<LoopResource, "kind">) =>
  owner.kind !== "Topic" || inputAttention(input) !== InputAttention.Deferred;
export function eligible(input: Input, owner: Readonly<LoopResource>, topicUids = new Set([owner.metadata.uid])): boolean {
  if (input.metadata.deletionTimestamp) return false;
  if (owner.kind === "Topic") return !(owner.spec as { parentRef?: unknown }).parentRef
    && belongsToTopic(input, resourceRef(owner), topicUids) && !!input.status.assess && !input.status.assess.completedAt && !input.status.assess.executionId;
  const receipt = attemptOf(input, resourceRef(owner));
  if (receipt?.completedAt) return false;
  if (owner.kind === "Route") return !receipt?.executionId || (!!input.status.route?.nextAttemptAt && Date.parse(input.status.route.nextAttemptAt) <= Date.now());
  return !!receipt && !receipt.executionId && (!["Task", "Routine"].includes(owner.kind) || !!input.status.handle?.[owner.metadata.uid]?.appliedAt);
}
/** @spec Due retries compete by original arrival, independently of new input selection; a failed parent cannot starve. */
export async function nextInputs(resources: ResourceClient, owner: Readonly<LoopResource>, limit: number,
  scope?: readonly import("./topic/model.ts").TopicResource[]) {
  const topics = scope ?? await topicScope(resources, resourceRef(owner));
  const topicUids = new Set(topics.map(t => t.metadata.uid));
  const inputs = await pendingInputs(resources, resourceRef(owner), topics, "assessReady");
  return [...inputs].filter(i => eligible(i, owner, topicUids)).sort((a, b) =>
    (owner.kind === "Route" ? 0 : attentionOrder[inputAttention(a.spec)] - attentionOrder[inputAttention(b.spec)])
    || (owner.kind === "Topic" ? Number(a.spec.origin === "trigger") - Number(b.spec.origin === "trigger") : 0)
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
  const topics = await topicScope(context.resources, resourceRef(owner));
  const topicUids = new Set(topics.map(t => t.metadata.uid));
  for (const input of await pendingInputs(context.resources, resourceRef(owner), topics, "assessReady")) {
    if (!eligible(input, owner, topicUids) || !canActivate(input.spec, owner)) continue;
    const result = await execution.verbs.action<{ accepted: boolean; reason?: string }>(owner.kind === "Topic" ? "submit_topic" : "submit_input", { inputId: input.metadata.name, operation: immediate(input.spec) ? "steer" : "followUp" });
    if (result.state === "failure") throw new Error(`Agent Input admission failed: ${result.error ?? "unknown error"}`);
    if (result.state === "success" && !result.value.accepted && ["not_running", "admission_conflict"].includes(result.value.reason ?? "")) retry = true;
  }
  return retry ? { requeueAfterMs: 100 } : undefined;
}
/** @spec Only the owning Reconcile invokes its Agent. All automatic input paths persist their admission before dispatch; version conflicts never dispatch stale batches. */
export async function runInput(context: PluginContext, execution: ReconcileContext, owner: Readonly<LoopResource>, target: string, prompt: string, inputId?: string, batchIds: readonly string[] = []) {
  const current = await context.resources.get<unknown, LoopStatus>(resourceRef(owner));
  if (!current || current.metadata.deletionTimestamp || current.status.execution) return;
  if (current.kind === "Topic" && (current.spec as { parentRef?: unknown }).parentRef) return;
  const inputIds = [...new Set([...(inputId ? [inputId] : []), ...batchIds])];
  if (inputIds.length > 20) throw new Error("Agent admission batch exceeds 20 Inputs");
  const inputs = await Promise.all(inputIds.map(id => context.resources.get<InputSpec, import("./input/model.ts").InputStatus>(inputRef(id))));
  const topics = await topicScope(context.resources, resourceRef(current));
  const topicUids = new Set(topics.map(t => t.metadata.uid));
  if (inputs.some(input => !input || !eligible(input, current, topicUids))) return;
  const startedAt = new Date().toISOString();
  try {
    await commitStatus(context.resources, [
      { operation: "patchStatus", resource: current, patch: { execution: { id: execution.executionId, startedAt, admissionRevision: 0, observedGeneration: current.metadata.generation },
        ...(current.kind === "Topic" ? { notifiedWeaveRevision: (owner.status as import("./topic/model.ts").TopicStatus).weaveRevision ?? 0, lastError: null } : {}) } },
      ...inputs.map(input => ({ operation: "patchStatus" as const, resource: input!, patch: attemptPatch(input!, resourceRef(current), {
        executionId: execution.executionId, agent: undefined, startedAt, lastError: undefined, nextAttemptAt: undefined,
        ...(current.kind === "Route" ? { attempts: (input!.status.route?.attempts ?? 0) + 1 } : {}) }, topicUids) })),
    ]);
  } catch (error) {
    // Reconcile reselects the remaining inputs and rebuilds its prompt after a competing claim.
    if (current.kind === "Topic" && /version conflict/.test(String(error))) return;
    throw error;
  }
  context.logger.info("Agent input admitted", { attributes: { resourceUid: current.metadata.uid, inputId: inputId ?? "timer", inputIds, executionId: execution.executionId } });
  let completed = false;
  let error = "Agent ended without confirming input completion";
  try {
    const agent = await prepareAgent(context.resources, execution, current, target);
    for (const input of current.kind === "Topic" ? inputs as Input[] : []) await changeAssessment(context.resources, input, execution.executionId, { agent });
    for (const id of current.kind === "Topic" ? [] : inputIds) await changeAttempt(context.resources, id, resourceRef(current), receipt =>
      receipt?.executionId === execution.executionId && !receipt.completedAt ? { agent } : {});
    const result = await execution.verbs.harness({ ...agent, title: current.kind === "Route" ? "Route" : current.kind === "Topic" ? "Chief" : current.kind, prompt, timeoutMs: 172800_000 });
    completed = result.state === "success" && result.value.result.stopReason === "end_turn";
    if (result.agent?.sessionId) await saveAgent(context.resources, current, execution.executionId, result.agent);
    if (result.state !== "success" || result.value.result.stopReason !== "end_turn") error = `Agent execution did not complete: ${result.state === "success" ? result.value.result.stopReason : result.state}`;
  } catch (cause) { error = String(cause); }
  finally { await finalizeExecution(context, current, execution.executionId, current.kind === "Topic" && completed ? "" : error); }
  return completed;
}
/**
 * @spec Admission evidence survives completion of the invocation and restart; unknown effects never automatically replay.
 * @why Chief idle time starts after every execution, including failure or recovery; missed timer checks never force continuation.
 * @case tests/topic-review.test.ts
 */
export async function finalizeExecution(context: Pick<PluginContext, "resources" | "logger">, owner: Readonly<LoopResource>, executionId: string,
  error = "Previous execution interrupted; inspect existing effects before continuing") {
  for (let n = 0; ; n++) {
    const latest = await context.resources.get<unknown, LoopStatus>(resourceRef(owner));
    if (!latest || latest.status.execution?.id !== executionId) return;
    const unfinished = latest.kind === "Topic"
      ? await context.resources.list<import("./input/model.ts").InputSpec, import("./input/model.ts").InputStatus>(INPUT_TYPE, { matchIndex: { name: "assessExecution", value: executionId } })
      : (await pendingInputs(context.resources, resourceRef(latest))).filter(i => attemptOf(i, resourceRef(latest))?.executionId === executionId);
    const at = new Date().toISOString();
    try {
      await commitStatus(context.resources, [
        ...unfinished.map(i => ({ operation: "patchStatus" as const, resource: i, patch: latest.kind === "Topic" ? { assess: { ...i.status.assess, lastError: error || "Chief ended without confirming input completion" } } : attemptPatch(i, resourceRef(latest), receipt => receipt?.executionId !== executionId || receipt.completedAt ? {} : { lastError: error,
          ...(latest.kind === "Route" ? { nextAttemptAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(i.status.route?.attempts ?? 1, 8))).toISOString() } : {}) }) })),
        { operation: "patchStatus", resource: latest, patch: { execution: null, ...(latest.kind === "Topic" ? { idleSince: at, lastError: error || null, reviewCheckedAt: null, idleReviewCount: 0, idleReviewReset: null } : {}), ...(["Task", "Routine"].includes(latest.kind) ? {
          lastExecutionId: executionId,
          ...((unfinished.length || (latest.status as import("./work-status.ts").WorkAgentStatus).lastExecutionId !== executionId)
            ? { recovery: { reason: "ExecutionUncertain", message: error || "Execution ended without a business receipt" } } : {}),
        } : {}) } },
      ]);
      if (latest.kind === "Topic" && error) context.logger.warn("Chief execution requires inspection", { attributes: { topicUid: latest.metadata.uid, executionId, error } });
      if (unfinished.length) context.logger.warn("Agent inputs await recovery", { attributes: { resourceUid: latest.metadata.uid, executionId,
        inputIds: unfinished.map(i => i.metadata.name), recovery: latest.kind === "Route" ? "retry" : "inspect", error } });
      return;
    } catch (cause) { if (n >= 8 || !/version conflict/.test(String(cause))) throw cause; }
  }
}
