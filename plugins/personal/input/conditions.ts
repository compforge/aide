import { setConditions } from "../conditions.ts";
import type { InputStatus } from "./model.ts";

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
