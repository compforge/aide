import type { PluginContext, ReconcileContext, ResourceClient } from "@compforge/aide-plugin";
import type { LoopResource } from "./loop.ts";
import { isProcessingRoot } from "../topic/boundary.ts";
import { inputExpired } from "../input/retention.ts";
import { InputAttention, inputAttention, assessmentFinished, type InputSpec } from "../input/model.ts";
import { pendingInputs, resourceRef, attemptOf, type Input } from "../input/state.ts";

export const immediate = (input: InputSpec) => inputAttention(input) === InputAttention.Immediate;
const attentionOrder = { [InputAttention.Immediate]: 0, [InputAttention.Normal]: 1, [InputAttention.Deferred]: 2 };
/** @spec Deferral controls Chief activation, not Route classification or explicit Work handoff. */
export const canActivate = (input: InputSpec, owner: Pick<LoopResource, "kind">) =>
  owner.kind !== "Topic" || inputAttention(input) !== InputAttention.Deferred;
export function eligible(input: Input, owner: Readonly<LoopResource>): boolean {
  if ((owner.kind === "Topic" && input.status.batchId) || input.metadata.deletionTimestamp || inputExpired(input)) return false;
  if (owner.kind === "Topic") return isProcessingRoot(owner as import("../topic/model.ts").TopicResource)
    && input.status.assess?.topic?.uid === owner.metadata.uid && !!input.status.assess && !assessmentFinished(input.status.assess) && !input.status.assess.executionId;
  const receipt = attemptOf(input, resourceRef(owner));
  if (receipt?.completedAt) return false;
  if (owner.kind === "Route") return !receipt?.executionId || (!!input.status.route?.nextAttemptAt && Date.parse(input.status.route.nextAttemptAt) <= Date.now());
  return !!receipt && !receipt.executionId && (!["Task", "Routine"].includes(owner.kind) || !!input.status.handle?.[owner.metadata.uid]?.appliedAt);
}
/** @spec Route and Work select their assigned Inputs; Chief owns its separate prepared Input/Batch queue.
 * @spec Due retries compete by original arrival; a failed parent cannot starve.
 */
export async function nextInputs(resources: ResourceClient, owner: Readonly<LoopResource>, limit: number) {
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
  for (const input of await pendingInputs(context.resources, resourceRef(owner))) {
    if (!eligible(input, owner) || !canActivate(input.spec, owner)) continue;
    const result = await execution.verbs.action<{ accepted: boolean; reason?: string }>("submit_input", { inputId: input.metadata.name, operation: immediate(input.spec) ? "steer" : "followUp" });
    if (result.state === "failure") throw new Error(`Agent Input admission failed: ${result.error ?? "unknown error"}`);
    if (result.state === "success" && !result.value.accepted && ["not_running", "admission_conflict"].includes(result.value.reason ?? "")) retry = true;
  }
  return retry ? { requeueAfterMs: 100 } : undefined;
}
