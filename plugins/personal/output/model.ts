import type { Address } from "@compforge/aide-plugin";
import type { Resource, ResourceRef } from "@compforge/aide-plugin";

export const OUTPUT_TYPE = { apiVersion: "aide.dev/v1alpha3", kind: "Output" } as const;

/** @spec Output content, intended receivers and destination are immutable. Input associations are optional many-to-many provenance, never consumption receipts. */
export interface OutputSpec {
  text: string;
  notes?: Array<{ uid: string; version: string; textVersion?: string }>;
  target: Address;
  /** @spec Intended Person references may dangle after deletion; independent of the delivery address and contributing Inputs. */
  receivers?: ResourceRef[];
  topic: ResourceRef & { uid: string };
  topicId: string;
  executionId?: string;
  producer?: ResourceRef;
  inputIds?: string[];
  /** Exact input incarnations at Output creation, keyed by input name. */
  inputUids?: Record<string, string>;
  createdBy?: import("../observation/reference.ts").AgentCall;
}
export interface OutputStatus {
  disclosure?: { decision: "allowed" | "denied"; reason: string; checkedAt: string; fingerprint: string; policy?: import("./policy.ts").DisclosurePolicy };
  delivery?: { replay?: "idempotent" | "once"; target: Address; text: string; receivers: ResourceRef[] };
  phase: "pending" | "sending" | "delivered" | "failed" | "uncertain";
  attempts: number;
  deliveredAt?: string;
  lastError?: string;
  receipt?: { id: string; scope: string };
}
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
  readonly target?: Address;
  /** Aide is always the speaker; this selects the recipient, never an impersonation identity. */
  readonly to?: { me: true } | { personId: string; uid: string };
  /** Configured Channel for private Person contact; target selects an explicit group/address. */
  readonly channelId?: string;
  /** Person references; explicit [] suppresses inference from respondToInputId's sender. */
  readonly receivers?: readonly ResourceRef[];
}
/** @spec Acceptance is durable and idempotent; it neither claims delivery nor requests Agent polling. */
export interface SayReceipt { readonly outputId: string; readonly accepted: true; }
export type SayResult = VerbResult<SayReceipt>;

