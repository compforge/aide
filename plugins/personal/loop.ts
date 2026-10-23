import { z } from "zod";
import type { PluginContext, ReconcileContext, Resource, ResourceClient } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus, type Processing } from "./input/model.ts";

/** @spec A loop keeps its native context; each invocation and each input's business receipt has its own lifetime. */
export const LoopExecutionSchema = z.object({ id: z.string(), startedAt: z.string(), admissionRevision: z.number().int().nonnegative().optional() }).strict();
export type LoopExecution = z.infer<typeof LoopExecutionSchema>;
export interface LoopStatus { pendingInputIds: string[]; execution?: LoopExecution | null }
export type LoopResource = Resource<unknown, LoopStatus>;
export const immediate = (input: InputSpec) => (input.attention ?? (input.origin === "channel" ? "immediate" : "deferred")) === "immediate";
export const inputRef = (name: string) => ({ ...INPUT_TYPE, namespace: "v1" as const, name });

export async function processing(resources: ResourceClient, inputId: string, consumerUid: string, change: (previous?: Processing) => Processing | undefined) {
  for (let attempt = 0; ; attempt++) {
    const input = await resources.get<InputSpec, InputStatus>(inputRef(inputId));
    if (!input) throw new Error(`Input no longer exists: ${inputId}`);
    const next = { ...input.status.processing };
    const value = change(next[consumerUid]);
    if (value) next[consumerUid] = value; else delete next[consumerUid];
    try { return await resources.patchStatus(input, { processing: next }); }
    catch (error) { if (attempt >= 8 || !/version conflict/.test(String(error))) throw error; }
  }
}

/** @spec Only unattempted inputs start automatically. Failed actions remain evidence until a new request revisits them. */
export async function nextInput(resources: ResourceClient, resource: Readonly<LoopResource>) {
  const inputs = await Promise.all(resource.status.pendingInputIds.map(id => resources.get<InputSpec, InputStatus>(inputRef(id))));
  return inputs.filter(i => i && !i.status.processing?.[resource.metadata.uid]).sort((a, b) => Number(immediate(b!.spec)) - Number(immediate(a!.spec)))[0];
}

/** @spec Intake never waits for inference. Immediate inputs enter the active invocation through an explicit host admission action. */
export async function steerPending(context: PluginContext, execution: ReconcileContext, resource: Readonly<LoopResource>) {
  if (!resource.status.execution) return;
  let retry = false;
  for (const id of resource.status.pendingInputIds) {
    const input = await context.resources.get<InputSpec, InputStatus>(inputRef(id));
    if (input && immediate(input.spec) && !input.status.processing?.[resource.metadata.uid]) {
      const result = await execution.verbs.action<{ accepted: boolean; reason?: string }>("steer_input", { inputId: id });
      if (result.state === "failure") throw new Error(`Immediate Input admission failed: ${result.error ?? "unknown error"}`);
      if (result.state === "success" && !result.value.accepted && ["not_running", "admission_conflict"].includes(result.value.reason ?? "")) retry = true;
    }
  }
  return retry ? { requeueAfterMs: 100 } : undefined;
}

/** @spec Persist admission before effects. Terminal execution never substitutes for a business completion receipt. */
export async function runInput(context: PluginContext, execution: ReconcileContext, resource: Readonly<LoopResource>,
  target: string, prompt: string, inputId?: string) {
  const ref = { ...resource, ...resource.metadata };
  const current = await context.resources.get<unknown, LoopStatus>(ref);
  if (!current || current.metadata.deletionTimestamp || current.status.execution) return;
  const input = inputId ? await context.resources.get<InputSpec, InputStatus>(inputRef(inputId)) : undefined;
  if (inputId && (!input || input.status.processing?.[current.metadata.uid] || !current.status.pendingInputIds.includes(inputId))) return;
  const startedAt = new Date().toISOString();
  await context.resources.commit([
    { operation: "patchStatus", resource: current, patch: { execution: { id: execution.executionId, startedAt, admissionRevision: 0 } } },
    ...(input ? [{ operation: "patchStatus" as const, resource: input, patch: { processing: { ...input.status.processing,
      [current.metadata.uid]: { executionId: execution.executionId, phase: "submitted", at: startedAt } } } }] : []),
  ]);
  context.logger.info("Agent input admitted", { attributes: { resourceUid: current.metadata.uid, inputId: inputId ?? "timer", executionId: execution.executionId } });
  let error = "Agent ended without confirming input completion";
  try {
    const result = await execution.verbs.harness({ title: target === "personal-route" ? "Route" : "Chief", harnessTargetId: target,
      prompt, timeoutMs: 172800_000 });
    if (result.state !== "success" || result.value.result.stopReason !== "end_turn") error = `Agent execution did not complete: ${result.state === "success" ? result.value.result.stopReason : result.state}`;
  } catch (cause) { error = String(cause); }
  finally { await finalizeExecution(context, current, execution.executionId, error); }
}

/** @spec Agent controllers serialize each resource. A previous execution at reconcile entry needs finalization only, never another Harness call.
 * @why Retry the atomic receipts-and-release transaction after transient failures; clearing the guard alone would strand submitted Inputs.
 * @case tests/conversation-loop.test.ts
 */
export async function finalizeExecution(context: PluginContext, resource: Readonly<LoopResource>, executionId: string,
  error = "Previous agent reconcile ended without finalizing; inspect existing effects before continuing") {
  const ref = { ...resource, ...resource.metadata };

  // Steer advances admissionRevision so late admission conflicts with this snapshot.
  for (let attempt = 0; ; attempt++) {
    const latest = await context.resources.get<unknown, LoopStatus>(ref);
    if (!latest || latest.status.execution?.id !== executionId) break;
    const inputs = await Promise.all(latest.status.pendingInputIds.map(id => context.resources.get<InputSpec, InputStatus>(inputRef(id))));
    const unfinished = inputs.filter(i => i?.status.processing?.[latest.metadata.uid]?.executionId === executionId
      && i.status.processing[latest.metadata.uid]!.phase === "submitted");
    try {
      await context.resources.commit([
        ...unfinished.map(input => ({ operation: "patchStatus" as const, resource: input!, patch: { processing: { ...input!.status.processing,
          [latest.metadata.uid]: { ...input!.status.processing![latest.metadata.uid]!, phase: "failed", error } } } })),
        { operation: "patchStatus", resource: latest, patch: { execution: null } },
      ]);
      if (unfinished.length) context.logger.warn("Agent ended with unacknowledged inputs", { attributes: {
        resourceUid: latest.metadata.uid, executionId, inputIds: unfinished.map(i => i!.metadata.name), error } });
      break;
    } catch (cause) { if (attempt >= 8 || !/version conflict/.test(String(cause))) throw cause; }
  }
}
