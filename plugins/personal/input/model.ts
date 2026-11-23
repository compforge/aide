import type { MaterialDisclosure } from "../disclosure.ts";
import type { ResourceRef } from "@compforge/aide-plugin";

export interface InputReceipt { inputId: string; at: string }

/**
 * @spec Secretary packs Deferred Inputs at the count or age threshold into Normal Batches.
 * A Chief handling business Inputs may assess related Deferred material; internal maintenance does not consume business receipts.
 * @link docs/personal/input.md#内容身份与调度
 */
export enum InputAttention {
  Immediate = "immediate",
  Normal = "normal",
  Deferred = "deferred",
}

export const INPUT_ORIGINS = ["channel", "source", "chief", "aide:curate", "aide:followup", "aide:triage", "aide:organize"] as const;
export type InputOrigin = typeof INPUT_ORIGINS[number];
export const isInternalInput = (input: Pick<InputSpec, "origin">): boolean =>
  input.origin.startsWith("aide:");
export const isCapacityInput = (input: Pick<InputSpec, "origin">): boolean =>
  input.origin === "aide:triage" || input.origin === "aide:organize";
export const inputQueue = (input: InputSpec): string => isInternalInput(input) ? input.origin : inputAttention(input);

export type InputRelation = "sent" | "received" | "observed";

export const INPUT_TYPE = { apiVersion: "aide.dev/v1alpha6", kind: "Input" } as const;
export interface InputSpec extends MaterialDisclosure {
  /** Producer-owned event key, stable across retries and intake paths; opaque to Personal. */
  inputKey?: string;
  /** Explicit delegated request; communication address and original user evidence stay independent of domain ownership. */
  handoff?: { id: string; gate: ResourceRef & { uid: string }; sourceInput: import("@compforge/aide-plugin").ResourceRef & { uid: string }; replyTo: import("../address/model.ts").AddressRef };
  /** Where the input was received; independent of its producer, sender and topic. */
  source?: import("../address/model.ts").AddressRef;
  /** Transport reply coordinates belong to this message, not the Address place. */
  replyToMessageId?: string;
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
  text: string;
  timezone?: string;
  observation?: Record<string, unknown>;
}
export type InputSubmission = Omit<InputSpec, "source"> & { source?: import("../address/service.ts").AddressTarget;
  addressObservation?: { name?: string; type?: import("../address/model.ts").AddressSpec["type"]; people?: Iterable<import("../person/model.ts").PersonRef> } };
export const inputAttention = (input: InputSpec): InputAttention =>
  input.attention ?? (input.origin === "channel" ? InputAttention.Immediate : InputAttention.Normal);

/** Each coordinator owns its own status. A model turn ending is not business completion. */
export interface Attempt {
  agent?: import("@compforge/aide-plugin").AgentStatus;
  completedBy?: import("../observation/reference.ts").AgentCall;
  executionId?: string;
  /** Native delivery identity shared by the original Inputs in one followUp batch. */
  deliveryId?: string;
  startedAt?: string;
  completedAt?: string;
  lastError?: string;
  errorAt?: string;
  /** Retry/recovery remains outstanding; an error alone does not release this obligation. */
  retryable?: boolean;
}
export interface Assessment extends Attempt {
  result?: { summary: string; curatedNotes?: { noteId: string; version: string }[]; disposition?: "completed" | "cancelled" | "rejected" };
}
/** @spec Persisted terminal results end assessment; retryable execution errors leave it pending. */
export const assessmentFinished = (assessment?: Assessment): boolean => !!(assessment?.completedAt || (assessment?.lastError && !assessment.retryable));

/** Retry timing derives from the execution error and the owning role's trigger interval. */
export const assessmentRetryDue = (assessment: Assessment | undefined, delayMs: number): boolean =>
  !assessment?.retryable || !assessment.errorAt || Date.parse(assessment.errorAt) + delayMs <= Date.now();

export interface Handling extends Assessment {
  resource: ResourceRef & { uid: string };
  assignedAt: string;
  /** Request applied; contextual handling still awaits execution confirmation. */
  appliedAt?: string;
  request: import("../work/model.ts").WorkInputRequest;
}
export interface InputStatus {
  /** Sole membership record, pinned to the Batch resource UID. */
  batchId?: string;
  /** Time Secretary sealed this membership; immutable together with batchId. */
  batchAt?: string;
  /** Resolved policy; Host computes release eligibility atomically with each receipt write. */
  retention?: { successSeconds: number; errorSeconds: number };
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
   * @spec One global assessment. Independent Inputs own admission; Batch members project their Batch receipt.
   * @why Ownership changes and concurrent admission must not automatically submit the same Input twice.
   * @link docs/personal/input.md#归属与-chief-通知
   * @case tests/input-admission.test.ts
   */
  assess?: Assessment & { topic?: ResourceRef & { uid: string } };
  handle?: Record<string, Handling>;
}
