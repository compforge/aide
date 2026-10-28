import { isDeepStrictEqual } from "node:util";
import type { Resource, ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { setConditions, type Condition, type ConditionValue } from "./conditions.ts";
import type { InputStatus } from "./input/model.ts";
import type { WorkSpecFields, WorkStatus, Work } from "./model.ts";
import type { WorkAgentStatus } from "./work-status.ts";

export function inputStatus(status: InputStatus): InputStatus {
  const assessed = !!status.assess?.completedAt;
  const pending = Object.values(status.handle ?? {}).filter(h => !h.completedAt);
  const attention = [status.assess, ...pending].find(a => a?.lastError && !a.completedAt);
  return { ...status, conditions: setConditions(status.conditions, [
    { type: "Assessed", status: assessed ? "True" : "False", reason: assessed ? "AssessmentRecorded" : "AwaitingAssessment", message: assessed ? "Assessment receipt recorded" : "No completed assessment" },
    { type: "HandlingComplete", status: !assessed ? "Unknown" : pending.length ? "False" : "True", reason: !assessed ? "AwaitingAssessment" : pending.length ? "PendingWork" : "HandlingSettled", message: !assessed ? "Handling obligations not yet determined" : `${pending.length} Work receipts pending; inspect individual outcomes` },
    { type: "NeedsAttention", status: attention ? "True" : "False", reason: attention ? "ExecutionUncertain" : "NoInterventionRequired", message: attention?.lastError ?? "" },
  ]) };
}
export function workPhase(work: Pick<Resource<WorkSpecFields, WorkAgentStatus>, "kind" | "spec" | "status" | "metadata">): Work["status"] {
  const s = work.status;
  if (work.spec.paused) return "paused";
  if (s.recovery) return s.recovery.reason === "InvalidResult" ? "invalid_result" : "uncertain";
  if (s.execution && s.lastExecutionId !== s.execution.id) return "running";
  if (s.waiting?.question) return "waiting";
  if (s.waiting?.until || (work.kind === "Routine" && (s.nextTriggerAt || s.lastOccurrence))) return "scheduled";
  if (work.kind === "Task" && s.completion?.observedGeneration === work.metadata.generation) return "done";
  return "ready";
}
export const workDueAt = (work: { kind: string; status: WorkStatus }) => work.status.waiting?.until ?? (work.kind === "Routine" ? work.status.nextTriggerAt : null) ?? null;
export const workBlocked = (work: { spec: WorkSpecFields; status: WorkStatus }) => !!work.spec.paused || !!work.status.recovery;
function workConditions(resource: Resource<WorkSpecFields, WorkAgentStatus>): Condition[] {
  const { spec, status: s, metadata } = resource;
  const observedGeneration = metadata.generation;
  const attention = !!s.recovery || !!s.waiting?.question;
  const values: ConditionValue[] = [{ type: "NeedsAttention", status: attention ? "True" : "False", reason: s.recovery?.reason ?? (s.waiting?.question ? "AwaitingUserAnswer" : "NoInterventionRequired"), message: s.recovery?.message ?? s.waiting?.question ?? "", observedGeneration }];
  if (resource.kind === "Task") values.push({ type: "Succeeded", status: s.completion?.observedGeneration === observedGeneration ? "True" : "False", reason: s.completion?.observedGeneration === observedGeneration ? "GoalAchieved" : "GoalPending", message: s.completion?.observedGeneration === observedGeneration ? s.completion.text : "Current goal has no completion receipt", observedGeneration });
  else values.push({ type: "Operational", status: metadata.deletionTimestamp || spec.paused || attention ? "False" : "True", reason: metadata.deletionTimestamp ? "Deleting" : spec.paused ? "Paused" : attention ? "InterventionRequired" : "AcceptingTriggers", message: s.recovery?.message ?? s.waiting?.question ?? "", observedGeneration });
  return setConditions(s.conditions, values);
}
/** @spec Personal owners construct facts and their conditions before one version-checked write.
 * @why Like controller-runtime Status().Patch, storage persists the supplied observation; it does not infer business conditions.
 * @case tests/status.test.ts
 * @link docs/status.md#conditions-契约
 */
function observed(kind: string, spec: unknown, status: unknown, generation: number, deletionTimestamp?: string): unknown {
  if (kind === "Input") return inputStatus(status as InputStatus);
  const current = status as { conditions?: Condition[]; lastError?: string | null };
  if (kind === "Topic") return { ...current, conditions: setConditions(current.conditions, [{ type: "NeedsAttention", status: current.lastError ? "True" : "False", reason: current.lastError ? "ExecutionUncertain" : "NoInterventionRequired", message: current.lastError ?? "" }]) };
  if (kind === "Task" || kind === "Routine") return { ...current, conditions: workConditions({ kind, spec, status, metadata: { generation, deletionTimestamp } } as Resource<WorkSpecFields, WorkAgentStatus>) };
  return status;
}
export function statusPatch<S, T>(resource: Readonly<Resource<S, T>>, patch: Partial<T>): Partial<T> {
  return observed(resource.kind, resource.spec, { ...resource.status, ...patch }, resource.metadata.generation, resource.metadata.deletionTimestamp) as T;
}
export function patchStatus<S, T>(resources: ResourceClient, resource: Readonly<Resource<S, T>>, patch: Partial<T>): Promise<Resource<S, T>> {
  return resources.patchStatus(resource, statusPatch(resource, patch));
}
export function commitStatus(resources: ResourceClient, writes: readonly ResourceCommit[]) {
  return resources.commit(writes.map(write => {
    if (write.operation === "patchStatus") return { ...write, patch: statusPatch(write.resource, write.patch) };
    if (write.operation === "replace") return { ...write, status: observed(write.resource.kind, write.spec, write.status,
      write.resource.metadata.generation + Number(!isDeepStrictEqual(write.resource.spec, write.spec)), write.resource.metadata.deletionTimestamp) };
    if (write.operation === "create" && write.type.apiVersion === "aide.dev/v1alpha2") return { ...write, status: observed(write.type.kind, write.spec, write.status ?? {}, 1) };
    return write;
  }));
}
/** Tool/channel Work is a presentation; only separated facts are stored in CRDs. */
export function workObservation(work: Work, generation: number): Omit<WorkStatus, "topic"> {
  const at = work.lastReport?.at ?? new Date().toISOString();
  const outcome = { at, text: work.lastReport?.text ?? "", observedGeneration: generation };
  return { summary: work.summary, recent: work.recent,
    ...(work.lastReport ? { lastReport: work.lastReport } : {}), ...(work.recoveryNotice ? { recoveryNotice: work.recoveryNotice } : {}),
    waiting: work.status === "waiting" ? { question: work.question! } : work.kind === "task" && work.nextAt ? { until: work.nextAt } : null,
    recovery: ["uncertain", "invalid_result", "running"].includes(work.status) ? { reason: work.status === "invalid_result" ? "InvalidResult" : "ExecutionUncertain", message: "Inspect previous execution effects" } : null,
    ...(work.kind === "task" ? { completion: work.status === "done" ? outcome : null } : { nextTriggerAt: work.nextAt }),
  };
}
