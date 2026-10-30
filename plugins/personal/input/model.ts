import type { Address } from "@compforge/aide-plugin";
import type { ResourceRef } from "@compforge/aide-plugin";
import type { PersonRef } from "../person/model.ts";

export interface InputReceipt { inputId: string; at: string }

/**
 * @spec Deferred Inputs attach without activating Chief or entering its native input queue.
 * An already active Chief may assess them, regardless of what activated it.
 * @link docs/personal/input.md#内容身份与调度
 */
export enum InputAttention {
  Immediate = "immediate",
  Normal = "normal",
  Deferred = "deferred",
}

export const INPUT_ORIGINS = ["channel", "source", "chief", "aide:review", "aide:triage", "aide:organize"] as const;
export type InputOrigin = typeof INPUT_ORIGINS[number];
export const isInternalInput = (input: Pick<InputSpec, "origin">): boolean =>
  input.origin === "aide:review" || input.origin === "aide:triage" || input.origin === "aide:organize";
export const isCapacityInput = (input: Pick<InputSpec, "origin">): boolean =>
  input.origin === "aide:triage" || input.origin === "aide:organize";
export const inputQueue = (input: InputSpec): string => isInternalInput(input) ? input.origin : inputAttention(input);

export type InputRelation = "sent" | "received" | "observed";

export const INPUT_TYPE = { apiVersion: "aide.dev/v1alpha3", kind: "Input" } as const;
export interface InputSpec {
  /** Where the input was received; independent of its producer, sender and topic. */
  source?: Address;
  /**
   * @spec Optional topic affinity supplied by the Channel or Source, which owns its stable identity and granularity.
   * Inputs sharing this ID have common context; different IDs do not imply unrelated topics or exclusive routing.
   * @link docs/personal/input.md#内容身份与调度
   */
  topicKey?: string;
  /** Suggested initial Topic name from the input adapter; does not select or rename an existing Topic. */
  topicName?: string;
  /** Explicit Topic selection, e.g. the Web composer. Current binding is persisted in status.topic. */
  topicId?: string;
  /** Scheduling urgency, independent of authority or notification intent. */
  attention?: InputAttention;
  origin: InputOrigin;
  /** Channel/Source definition or internal producer ID, selected by origin. */
  originId: string;
  /** Producing Source or Topic resource; provenance, never an implicit routing destination. */
  originRef?: ResourceRef;
  /**
   * @spec Relation to the Person: authored by them, addressed to them, or visible in their information environment.
   * Observed does not prove the Person read it; received does not imply endorsement or delegation.
   * Absent means unknown. Context messages retain their own authorship and relation.
   */
  relation?: InputRelation;
  /** Optional sender reference; the Person may have been deleted. System events and multi-author observations may have no sender. */
  sender?: ResourceRef;
  /** Explicitly identified human recipients; absent/empty never means all. No audience expansion. */
  receivers?: PersonRef[];
  text: string;
  timezone?: string;
  observation?: Record<string, unknown>;
}
export const inputAttention = (input: InputSpec): InputAttention =>
  input.attention ?? (input.origin === "channel" ? InputAttention.Immediate : InputAttention.Normal);

/** Each coordinator owns its own status. A model turn ending is not business completion. */
export interface Attempt {
  agent?: import("@compforge/aide-plugin").AgentStatus;
  completedBy?: import("../observation/reference.ts").AgentCall;
  executionId?: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
}
export interface Assessment extends Attempt {
  result?: { summary: string; disposition?: "completed" | "cancelled" | "rejected" };
}
export interface Handling extends Assessment {
  resource: ResourceRef & { uid: string };
  assignedAt: string;
  /** Request applied; contextual handling still awaits execution confirmation. */
  appliedAt?: string;
  request: import("../model.ts").WorkInputRequest;
}
export interface InputStatus {
  conditions?: import("../conditions.ts").Condition[];
  organization?: import("../topic/ref.ts").Organization;
  /** Current ownership; routing receipts retain the initial decision. */
  topic?: ResourceRef & { uid: string };
  route?: Attempt & {
    nextAttemptAt?: string;
    attempts?: number;
    result?: { topics: Array<ResourceRef & { uid: string }>; reason: string };
  };
  /**
   * @spec One global assessment. All automatic Chief submissions atomically claim executionId before dispatch.
   * @why Ownership changes and concurrent admission must not automatically submit the same Input twice.
   * @link docs/personal/input.md#归属与-chief-通知
   * @case tests/input-admission.test.ts
   */
  assess?: Assessment & { topic?: ResourceRef & { uid: string } };
  handle?: Record<string, Handling>;
}
