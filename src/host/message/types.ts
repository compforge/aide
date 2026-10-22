export type ActorKind = "user" | "harness" | "plugin" | "aide" | (string & {});
export interface ActorRef { readonly kind: ActorKind; readonly key: string; }
import type { AgentMessagePhase, ContentBlock } from "../event/index.ts";
import type { ApprovalAnswer, ApprovalCancellationReason, ApprovalDraft } from "../approval/types.ts";


/**
 * @spec Message identity and authorship survive content updates, delivery receipts and replay.
 * Reply references describe interaction, never execution ownership or consumption.
 */
export interface MessageBase {
  messageId: string;
  source: ActorRef;
  target?: ActorRef;
  /** Omitted = unknown; [] = no specific reply target. */
  replyToMessageIds?: readonly string[];
  createdAt: string;
}

interface ContentMessage extends MessageBase {
  content: ContentBlock[];
}

export interface Input extends ContentMessage {
  kind: "input";
  role: "user";
}

export interface Output extends ContentMessage {
  kind: "output";
  role: "agent" | "thought";
  streamStatus?: "in_progress" | "completed";
  phase?: AgentMessagePhase;
}

export interface InputRequest extends MessageBase {
  kind: "input_request";
  target: ActorRef;
  request: ApprovalDraft;
  status: "pending" | "answered" | "cancelled";
  expiresAt?: string;
  responseMessageId?: string;
  cancellation?: { reason: ApprovalCancellationReason; detail?: string };
}

export interface InputResponse extends MessageBase {
  kind: "input_response";
  target: ActorRef;
  /** Exactly one request; a generic reply cannot authorize or settle it. */
  replyToMessageIds: readonly [string];
  answer: ApprovalAnswer;
}

/** Native approvals reuse request/response Message identity. */
export type Approval = InputRequest | InputResponse;
export type Message = Input | Output | Approval;
