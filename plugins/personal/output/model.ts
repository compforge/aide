import { KeyedSet } from "@compforge/ts-stdx/collections";
import type { Address } from "@compforge/aide-plugin";
import type { Resource, ResourceRef } from "@compforge/aide-plugin";

export const OUTPUT_TYPE = { apiVersion: "aide.dev/v1alpha5", kind: "Output" } as const;

/** @spec Output content, intended receivers and destination are immutable. Input associations are optional many-to-many provenance, never consumption receipts. */
export interface OutputSpec {
  stream: import("@compforge/aide-plugin").StreamRef;
  target: import("../address/model.ts").AddressRef;
  replyTo?: { input: ResourceRef & { uid: string }; key: string; messageId?: string };
  replyToMessageId?: string;
  /** @spec Intended Person references may dangle after deletion; independent of the delivery address and contributing Inputs. */
  receivers?: import("../person/model.ts").PersonRefs;
  topic: ResourceRef & { uid: string };
  topicId: string;
  executionId?: string;
  producer?: ResourceRef;
  inputIds?: string[];
  /** Exact input incarnations at Output creation, keyed by input name. */
  inputUids?: Record<string, string>;
  createdBy?: import("../observation/reference.ts").AgentCall;
}
export type OutputSubmission = Omit<OutputSpec, "target"> & { target: import("../address/service.ts").AddressTarget };
/** @spec delivery records who actually receives what and where; it never rewrites the expected receivers/stream/target in spec. */
/** One transport operation pins a Stream snapshot until a successful acknowledgement; new progress gets a new budget. */
export interface OutputOperation {
  snapshot: import("@compforge/aide-plugin").StreamStatus;
  attempts: number;
  maxAttempts: number;
  lastFailureKind?: "retryable" | "permanent" | "unknown";
}
export interface OutputStatus {
  disclosure?: { decision: "allowed" | "denied"; reason: string; checkedAt: string; fingerprint: string; policy?: import("./policy.ts").DisclosurePolicy };
  delivery?: { notice?: "muted"; replay?: "idempotent" | "once"; address: import("../address/model.ts").AddressRef; target: Address; stream: import("@compforge/aide-plugin").StreamRef; confirmedSeq?: number; operation?: OutputOperation; receivers: import("../person/model.ts").PersonRefs };
  waitingAddress?: import("../address/model.ts").AddressRef;
  phase: "pending" | "sending" | "delivered" | "failed" | "uncertain" | "cancelled";
  attempts: number;
  preparationAttempts?: number;
  deliveryWait?: { reason: "frequency" | "receiver-busy" | "provider"; until: string };
  deliveredAt?: string;
  lastError?: string;
  receipt?: { id: string; scope: string };
}
export interface OutputReconcileResult { requeueAfterMs?: number }
export type Output = Resource<OutputSpec, OutputStatus>;

import type { VerbResult } from "@compforge/aide-plugin";
/** Persists an Output; success acknowledges creation, while status separately reports delivery (never reading). */
export interface SayInput {
  readonly text: string;
  readonly notes?: readonly { uid: string; version: string }[];
  readonly inputIds?: readonly string[];
  readonly idempotencyKey?: string;
  /** Only a Channel Input establishes a direct reply path; observations require a separately chosen notification target. */
  readonly respondToInputId?: string;
  readonly target?: import("../address/model.ts").AddressRef;
  /** Aide is always the speaker; this selects the recipient, never an impersonation identity. */
  readonly to?: { me: true };
  /** Person references; explicit [] suppresses inference from respondToInputId's sender. */
  readonly receivers?: Iterable<ResourceRef>;
}
/** @spec Acceptance is durable and idempotent; it neither claims delivery nor requests Agent polling. */
export interface SayReceipt { readonly outputId: string; readonly accepted: true; }
export type SayResult = VerbResult<SayReceipt>;

/** Compare intent/delivery by Person UID membership; reference serialization is not recipient identity. */
export const receiverIdentity = <T extends { receivers?: Iterable<ResourceRef> }>(value: T | undefined) => value && ({ ...value,
  receivers: value.receivers === undefined ? undefined : [...new KeyedSet(person => person.uid!, value.receivers)].map(person => person.uid).sort() });

/** Delivery progress can change without changing the authorized recipient, destination or Stream identity. */
export const deliveryIdentity = (value: OutputStatus["delivery"]) => value && receiverIdentity({ ...value, confirmedSeq: undefined, operation: undefined });
