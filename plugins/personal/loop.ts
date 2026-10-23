import { z } from "zod";
import type { PluginContext, ReconcileContext, Resource, ResourceClient } from "@compforge/aide-plugin";
import type { InputSpec } from "./input/model.ts";
import { inputRef, pendingInputs, resourceRef, attemptOf, attemptPatch, type Input } from "./input/state.ts";
export { inputRef } from "./input/state.ts";
/** A persistent native session owns context; each invocation has a separate durable admission identity. */
export const LoopExecutionSchema = z.object({ id: z.string(), startedAt: z.string(), admissionRevision: z.number().int().nonnegative().optional() }).strict();
export type LoopExecution = z.infer<typeof LoopExecutionSchema>;
export interface LoopStatus { agent?: import("@compforge/aide-plugin").AgentStatus; execution?: LoopExecution | null }
export type LoopResource = Resource<unknown, LoopStatus>;
export const immediate = (input: InputSpec) => (input.attention ?? (input.origin === "channel" ? "immediate" : "deferred")) === "immediate";
export function eligible(input: Input, owner: Readonly<LoopResource>): boolean {
  if (input.metadata.deletionTimestamp) return false;
  const receipt = attemptOf(input, resourceRef(owner));
  if (receipt?.completedAt) return false;
  if (owner.kind === "Route") return !receipt?.executionId || (!!input.status.route?.nextAttemptAt && Date.parse(input.status.route.nextAttemptAt) <= Date.now());
  return !!receipt && !receipt.executionId;
}
/** @spec Due retries compete by original arrival, independently of new input selection; a failed parent cannot starve. */
export async function nextInput(resources: ResourceClient, owner: Readonly<LoopResource>) {
  const inputs = await pendingInputs(resources, resourceRef(owner));
  return [...inputs].filter(i => eligible(i, owner)).sort((a, b) =>
    (owner.kind === "Route" ? 0 : Number(immediate(b.spec)) - Number(immediate(a.spec)))
    || a.metadata.creationTimestamp.localeCompare(b.metadata.creationTimestamp) || a.metadata.name.localeCompare(b.metadata.name))[0];
}
export async function retryDelay(resources: ResourceClient, owner: Readonly<LoopResource>) {
  const times = (await pendingInputs(resources, resourceRef(owner))).flatMap(i => i.status.route?.nextAttemptAt ? [Date.parse(i.status.route.nextAttemptAt)] : []);
  return times.length ? { requeueAfterMs: Math.max(1, Math.min(...times) - Date.now()) } : undefined;
}
export async function steerPending(context: PluginContext, execution: ReconcileContext, owner: Readonly<LoopResource>) {
  if (!owner.status.execution) return;
  let retry = false;
  for (const input of await pendingInputs(context.resources, resourceRef(owner))) {
    if (!immediate(input.spec) || !eligible(input, owner)) continue;
    const result = await execution.verbs.action<{ accepted: boolean; reason?: string }>("steer_input", { inputId: input.metadata.name });
    if (result.state === "failure") throw new Error(`Immediate Input admission failed: ${result.error ?? "unknown error"}`);
    if (result.state === "success" && !result.value.accepted && ["not_running", "admission_conflict"].includes(result.value.reason ?? "")) retry = true;
  }
  return retry ? { requeueAfterMs: 100 } : undefined;
}
/** Persist admission before effects. Only tools can finish business processing, never end_turn. */
export async function runInput(context: PluginContext, execution: ReconcileContext, owner: Readonly<LoopResource>, target: string, prompt: string, inputId?: string) {
  const current = await context.resources.get<unknown, LoopStatus>(resourceRef(owner));
  if (!current || current.metadata.deletionTimestamp || current.status.execution) return;
  const input = inputId ? await context.resources.get<InputSpec, import("./input/model.ts").InputStatus>(inputRef(inputId)) : undefined;
  if (inputId && (!input || !eligible(input, current))) return;
  const startedAt = new Date().toISOString();
  await context.resources.commit([
    { operation: "patchStatus", resource: current, patch: { execution: { id: execution.executionId, startedAt, admissionRevision: 0 } } },
    ...(input ? [{ operation: "patchStatus" as const, resource: input, patch: attemptPatch(input, resourceRef(current), {
      executionId: execution.executionId, startedAt, nextAttemptAt: undefined,
      ...(current.kind === "Route" ? { attempts: (input.status.route?.attempts ?? 0) + 1 } : {}) }) }] : []),
  ]);
  context.logger.info("Agent input admitted", { attributes: { resourceUid: current.metadata.uid, inputId: inputId ?? "timer", executionId: execution.executionId } });
  let error = "Agent ended without confirming input completion";
  try {
    const result = await execution.verbs.harness({ title: current.kind === "Route" ? "Route" : "Chief", harnessTargetId: target, agentKey: "agent", prompt, timeoutMs: 172800_000 });
    if (result.state !== "success" || result.value.result.stopReason !== "end_turn") error = `Agent execution did not complete: ${result.state === "success" ? result.value.result.stopReason : result.state}`;
  } catch (cause) { error = String(cause); }
  finally { await finalizeExecution(context, current, execution.executionId, error); }
}
/** @spec Route classification may retry; uncertain Chief effects require inspection. Both retain admission evidence across restart. */
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
        { operation: "patchStatus", resource: latest, patch: { execution: null } },
      ]);
      if (unfinished.length) context.logger.warn("Agent inputs await recovery", { attributes: { resourceUid: latest.metadata.uid, executionId,
        inputIds: unfinished.map(i => i.metadata.name), recovery: latest.kind === "Route" ? "retry" : "inspect", error } });
      return;
    } catch (cause) { if (n >= 8 || !/version conflict/.test(String(cause))) throw cause; }
  }
}
