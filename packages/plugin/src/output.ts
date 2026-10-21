import type { Address } from "./address.ts";
import type { Resource, ResourceRef } from "./resource.ts";

export const OUTPUT_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Output" } as const;

/** @spec Output content, intended receivers and destination are immutable. Input associations are optional many-to-many provenance, never consumption receipts. */
export interface OutputSpec {
  text: string;
  target: Address;
  /** @spec Intended Person references; independent of the delivery address and contributing Inputs. */
  receivers?: ResourceRef[];
  conversation: ResourceRef & { uid: string };
  conversationId: string;
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
}
export type Output = Resource<OutputSpec, OutputStatus>;
