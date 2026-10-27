import { z } from "zod";
import { prepareAgent, saveAgent } from "./session.ts";
import type { PluginContext, ReconcileContext, Resource, ResourceClient } from "@compforge/aide-plugin";
import { InputAttention, inputAttention, type InputSpec } from "./input/model.ts";
import { inputRef, pendingInputs, resourceRef, changeAttempt, attemptOf, attemptPatch, type Input } from "./input/state.ts";
export { inputRef } from "./input/state.ts";
/** A persistent native session owns context; each invocation has a separate durable admission identity. */
export const LoopExecutionSchema = z.object({ id: z.string(), startedAt: z.string(), admissionRevision: z.number().int().nonnegative().optional() }).strict();
export type LoopExecution = z.infer<typeof LoopExecutionSchema>;
export interface LoopStatus { agent?: import("@compforge/aide-plugin").AgentStatus; execution?: LoopExecution | null }
export type LoopResource = Resource<unknown, LoopStatus>;
export const immediate = (input: InputSpec) => inputAttention(input) === InputAttention.Immediate;
const attentionOrder = { [InputAttention.Immediate]: 0, [InputAttention.Normal]: 1, [InputAttention.Deferred]: 2 };
/** @spec Deferral controls Chief activation, not Route classification or explicit Work handoff. */
export const canActivate = (input: InputSpec, owner: Pick<LoopResource, "kind">) =>
  owner.kind !== "Topic" || inputAttention(input) !== InputAttention.Deferred;
export function eligible(input: Input, owner: Readonly<LoopResource>): boolean {
  if (input.metadata.deletionTimestamp) return false;
  if (owner.kind === "Topic" && ((owner.spec as { parentRef?: unknown }).parentRef || (owner.status as { weaveLock?: string }).weaveLock)) return false;
  const receipt = attemptOf(input, resourceRef(owner));
  if (receipt?.completedAt) return false;
  if (owner.kind === "Route") return !receipt?.executionId || (!!input.status.route?.nextAttemptAt && Date.parse(input.status.route.nextAttemptAt) <= Date.now());
  return !!receipt && !receipt.executionId && (!["Task", "Routine"].includes(owner.kind) || !!input.status.handle?.[owner.metadata.uid]?.appliedAt);
}
/** @spec Due retries compete by original arrival, independently of new input selection; a failed parent cannot starve. */
export async function nextInputs(resources: ResourceClient, owner: Readonly<LoopResource>, limit: number) {
  const inputs = await pendingInputs(resources, resourceRef(owner));
  return [...inputs].filter(i => eligible(i, owner)).sort((a, b) =>
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
  for (const input of await pendingInputs(context.resources, resourceRef(owner))) {
    if (!eligible(input, owner) || !canActivate(input.spec, owner)) continue;
    const result = await execution.verbs.action<{ accepted: boolean; reason?: string }>("submit_input", { inputId: input.metadata.name });
    if (result.state === "failure") throw new Error(`Agent Input admission failed: ${result.error ?? "unknown error"}`);
    if (result.state === "success" && !result.value.accepted && ["not_running", "admission_conflict"].includes(result.value.reason ?? "")) retry = true;
  }
  return retry ? { requeueAfterMs: 100 } : undefined;
}
/** Persist admission before effects. Only tools can finish business processing, never end_turn. */
export async function runInput(context: PluginContext, execution: ReconcileContext, owner: Readonly<LoopResource>, target: string, prompt: string, inputId?: string, batchIds: readonly string[] = []) {
  const current = await context.resources.get<unknown, LoopStatus>(resourceRef(owner));
  if (!current || current.metadata.deletionTimestamp || current.status.execution) return;
  if (current.kind === "Topic" && ((current.spec as { parentRef?: unknown }).parentRef || (current.status as { weaveLock?: string }).weaveLock)) return;
  const inputIds = [...new Set([...(inputId ? [inputId] : []), ...batchIds])];
  if (inputIds.length > 20) throw new Error("Agent admission batch exceeds 20 Inputs");
  const inputs = await Promise.all(inputIds.map(id => context.resources.get<InputSpec, import("./input/model.ts").InputStatus>(inputRef(id))));
  if (inputs.some(input => !input || !eligible(input, current))) return;
  const startedAt = new Date().toISOString();
  await context.resources.commit([
    { operation: "patchStatus", resource: current, patch: { execution: { id: execution.executionId, startedAt, admissionRevision: 0 } } },
    ...inputs.map(input => ({ operation: "patchStatus" as const, resource: input!, patch: attemptPatch(input!, resourceRef(current), {
      executionId: execution.executionId, agent: undefined, startedAt, nextAttemptAt: undefined,
      ...(current.kind === "Route" ? { attempts: (input!.status.route?.attempts ?? 0) + 1 } : {}) }) })),
  ]);
  context.logger.info("Agent input admitted", { attributes: { resourceUid: current.metadata.uid, inputId: inputId ?? "timer", inputIds, executionId: execution.executionId } });
  let completed = false;
  let error = "Agent ended without confirming input completion";
  try {
    const agent = await prepareAgent(context.resources, execution, current, target);
    for (const id of inputIds) await changeAttempt(context.resources, id, resourceRef(current), receipt =>
      receipt?.executionId === execution.executionId && !receipt.completedAt ? { agent } : {});
    const result = await execution.verbs.harness({ ...agent, title: current.kind === "Route" ? "Route" : current.kind === "Topic" ? "Chief" : current.kind, prompt, timeoutMs: 172800_000 });
    completed = result.state === "success" && result.value.result.stopReason === "end_turn";
    if (result.agent?.sessionId) await saveAgent(context.resources, current, execution.executionId, result.agent);
    if (result.state !== "success" || result.value.result.stopReason !== "end_turn") error = `Agent execution did not complete: ${result.state === "success" ? result.value.result.stopReason : result.state}`;
  } catch (cause) { error = String(cause); }
  finally { await finalizeExecution(context, current, execution.executionId, error); }
  return completed;
}
/**
 * @spec Route classification may retry; uncertain Chief effects require inspection. Both retain admission evidence across restart.
 * @why Chief idle time starts after every execution, including failure or recovery; missed timer checks never force continuation.
 * @case tests/topic-trigger.test.ts
 */
export async function finalizeExecution(context: Pick<PluginContext, "resources" | "logger">, owner: Readonly<LoopResource>, executionId: string,
  error = "Previous execution interrupted; inspect existing effects before continuing") {
  for (let n = 0; ; n++) {
    const latest = await context.resources.get<unknown, LoopStatus>(resourceRef(owner));
    if (!latest || latest.status.execution?.id !== executionId) return;
    const unfinished = (await pendingInputs(context.resources, resourceRef(latest))).filter(i => attemptOf(i, resourceRef(latest))?.executionId === executionId);
    try {
      await context.resources.commit([
        ...unfinished.map(i => ({ operation: "patchStatus" as const, resource: i, patch: attemptPatch(i, resourceRef(latest), { lastError: error,
          ...(latest.kind === "Route" ? { nextAttemptAt: new Date(Date.now() + Math.min(300_000, 1000 * 2 ** Math.min(i.status.route?.attempts ?? 1, 8))).toISOString() } : {}) }) })),
        { operation: "patchStatus", resource: latest, patch: { execution: null, ...(latest.kind === "Topic" ? { idleSince: new Date().toISOString() } : {}), ...(["Task", "Routine"].includes(latest.kind) ? {
          lastExecutionId: executionId,
          ...((unfinished.length || (latest.status as LoopStatus & { status?: string }).status === "running")
            && (latest.status as LoopStatus & { status?: string }).status !== "paused" ? { status: "uncertain" } : {}),
        } : {}) } },
      ]);
      if (unfinished.length) context.logger.warn("Agent inputs await recovery", { attributes: { resourceUid: latest.metadata.uid, executionId,
        inputIds: unfinished.map(i => i.metadata.name), recovery: latest.kind === "Route" ? "retry" : "inspect", error } });
      return;
    } catch (cause) { if (n >= 8 || !/version conflict/.test(String(cause))) throw cause; }
  }
}
