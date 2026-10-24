import type { Address } from "@compforge/aide-plugin";
import type { Resource, ResourceRef } from "@compforge/aide-plugin";

export const OUTPUT_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Output" } as const;

/** @spec Output content, intended receivers and destination are immutable. Input associations are optional many-to-many provenance, never consumption receipts. */
export interface OutputSpec {
  text: string;
  target: Address;
  /** @spec Intended Person references may dangle after deletion; independent of the delivery address and contributing Inputs. */
  receivers?: ResourceRef[];
  topic: ResourceRef & { uid: string };
  topicId: string;
  executionId?: string;
  producer?: ResourceRef;
  inputIds?: string[];
}
export interface OutputStatus {
  phase: "pending" | "sending" | "delivered" | "failed" | "uncertain";
  attempts: number;
  nextAttemptAt?: string;
  deliveredAt?: string;
  lastError?: string;
  receipt?: { id: string; scope: string };
}
export type Output = Resource<OutputSpec, OutputStatus>;

import type { VerbResult } from "@compforge/aide-plugin";
/** Persists an Output; success acknowledges creation, while status separately reports delivery (never reading). */
export interface SayInput {
  readonly text: string;
  readonly inputIds?: readonly string[];
  readonly idempotencyKey?: string;
  readonly respondToInputId?: string;
  readonly target?: Address;
  /** Person references; explicit [] suppresses inference from respondToInputId's sender. */
  readonly receivers?: readonly ResourceRef[];
}
/** @spec Acceptance is durable and idempotent; it neither claims delivery nor requests Agent polling. */
export interface SayReceipt { readonly outputId: string; readonly accepted: true; }
export type SayResult = VerbResult<SayReceipt>;

