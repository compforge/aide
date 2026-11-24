import { setConditions } from "../conditions.ts";
import type { InputStatus } from "./model.ts";

export function inputStatus(status: InputStatus): InputStatus {
  const settled = !!status.assess?.completedAt;
  const disposition = status.assess?.result?.disposition;
  const closed = disposition === "cancelled" || disposition === "rejected";
  const delivered = settled && !closed;
  const pending = Object.values(status.handle ?? {}).filter(h => !h.completedAt);
  const attention = [status.assess, ...pending].find(a => a?.lastError && !a.completedAt);
  return { ...status, conditions: setConditions(status.conditions?.filter(c => c.type !== "Assessed"), [
    { type: "Delivered", status: delivered ? "True" : "False", reason: closed ? "ClosedWithoutDelivery" : delivered ? "InputDelivered" : "AwaitingDelivery", message: closed ? `Input ${disposition}` : delivered ? "Input delivered to Chief" : "Awaiting Input delivery" },
    { type: "HandlingComplete", status: !settled ? "Unknown" : pending.length ? "False" : "True", reason: !settled ? "AwaitingDelivery" : pending.length ? "PendingWork" : "HandlingSettled", message: !settled ? "Handling obligations not yet determined" : `${pending.length} Work receipts pending; inspect individual outcomes` },
    { type: "NeedsAttention", status: attention ? "True" : "False", reason: attention ? "ExecutionUncertain" : "NoInterventionRequired", message: attention?.lastError ?? "" },
  ]) };
}
