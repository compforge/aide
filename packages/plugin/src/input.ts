import type { Address } from "./address.ts";
import type { ResourceRef } from "./resource.ts";

export interface InputReceipt { inputId: string; at: string }

export type InputRelation = "sent" | "received" | "observed";

export const INPUT_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Input" } as const;
export interface InputSpec {
  /** Where the input was received; independent of its producer, sender and topic. */
  source?: Address;
  /**
   * @spec Optional topic affinity supplied by the Channel or Source, which owns its stable identity and granularity.
   * Inputs sharing this ID have common context; different IDs do not imply unrelated topics or exclusive routing.
   * @link docs/kernel.md
   */
  sessionId?: string;
  /** Scheduling urgency, independent of authority or notification intent. */
  attention?: "immediate" | "deferred";
  origin: "channel" | "source";
  /** ChannelDefinition or SourceDefinition ID, selected by origin. */
  originId: string;
  /** Producing Source resource; provenance, never a routing destination. */
  originRef?: ResourceRef;
  /**
   * @spec Relation to the Person: authored by them, addressed to them, or visible in their information environment.
   * Observed does not prove the Person read it; received does not imply endorsement or delegation.
   * Absent means unknown. Context messages retain their own authorship and relation.
   */
  relation?: InputRelation;
  /** Optional sender reference. System events and multi-author observations may have no sender. */
  sender?: ResourceRef;
  text: string;
  timezone?: string;
  observation?: Record<string, unknown>;
}
/** Routing state belongs to the consuming plugin; the Core persists it without interpreting destinations. */
export interface InputStatus {
  /** Attached Conversation incarnation IDs; retained after a recent-history window forgets the Input. */
  deliveries?: string[];
  routing?: {
    phase: "running" | "done" | "ignored";
    /** Preserve the first-Conversation shortcut across a partial creation and restart. */
    bootstrap?: boolean;
    /** Stable identity for the one rule-created Conversation; uid pins its incarnation before append. */
    creation?: { sessionId: string; name: string; uid?: string };
    reason: string;
  };
}
