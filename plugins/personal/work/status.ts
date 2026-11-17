import type { Resource } from "@compforge/aide-plugin";
import { setConditions, type Condition, type ConditionValue } from "../conditions.ts";
import type { WorkSpecFields, WorkStatus, Work } from "./model.ts";
import type { WorkAgentStatus } from "./agent-status.ts";

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
export function workConditions(resource: Resource<WorkSpecFields, WorkAgentStatus>): Condition[] {
  const { spec, status: s, metadata } = resource;
  const observedGeneration = metadata.generation;
  const attention = !!s.recovery || !!s.waiting?.question;
  const values: ConditionValue[] = [{ type: "NeedsAttention", status: attention ? "True" : "False", reason: s.recovery?.reason ?? (s.waiting?.question ? "AwaitingUserAnswer" : "NoInterventionRequired"), message: s.recovery?.message ?? s.waiting?.question ?? "", observedGeneration }];
  if (resource.kind === "Task") values.push({ type: "Succeeded", status: s.completion?.observedGeneration === observedGeneration ? "True" : "False", reason: s.completion?.observedGeneration === observedGeneration ? "GoalAchieved" : "GoalPending", message: s.completion?.observedGeneration === observedGeneration ? s.completion.text : "Current goal has no completion receipt", observedGeneration });
  else values.push({ type: "Operational", status: metadata.deletionTimestamp || spec.paused || attention ? "False" : "True", reason: metadata.deletionTimestamp ? "Deleting" : spec.paused ? "Paused" : attention ? "InterventionRequired" : "AcceptingTriggers", message: s.recovery?.message ?? s.waiting?.question ?? "", observedGeneration });
  return setConditions(s.conditions, values);
}
/** Tool/channel Work is a presentation; only separated facts are stored in CRDs. */
export function workObservation(work: Work, generation: number): Omit<WorkStatus, "topic"> {
  const at = work.lastReport?.at ?? new Date().toISOString();
  const outcome = { at, text: work.lastReport?.text ?? "", observedGeneration: generation };
  return { summaryRevision: work.summaryRevision,
    ...(work.lastReport ? { lastReport: work.lastReport } : {}), ...(work.recoveryNotice ? { recoveryNotice: work.recoveryNotice } : {}),
    waiting: work.status === "waiting" ? { question: work.question! } : work.kind === "task" && work.nextAt ? { until: work.nextAt } : null,
    recovery: ["uncertain", "invalid_result", "running"].includes(work.status) ? { reason: work.status === "invalid_result" ? "InvalidResult" : "ExecutionUncertain", message: "Inspect previous execution effects" } : null,
    ...(work.kind === "task" ? { completion: work.status === "done" ? outcome : null } : { nextTriggerAt: work.nextAt }),
  };
}
