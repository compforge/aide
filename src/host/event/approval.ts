import type { InputRequest } from "../message/types.ts";
import type { ApprovalCancellationReason } from "../approval/types.ts";

/** Creation carries the Message itself; execution correlation belongs only to the fact. */
export type InputRequestCreated = InputRequest & {
  status: "pending";
};

export interface InputRequestCancelled {
  messageId: string;
  reason: ApprovalCancellationReason;
  detail?: string;
}
