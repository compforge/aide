import type { ResourceRef } from "./resource.ts";

export interface InputReceipt { inputId: string; at: string }

export const INPUT_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Input" } as const;
export interface InputSpec {
  /** Known destination supplied by the producer; other related conversations may also consume this Input. */
  sessionId?: string;
  origin: "channel" | "source";
  /** ChannelDefinition or SourceDefinition ID, selected by origin. */
  originId: string;
  /** Producing Source resource; provenance, never a routing destination. */
  originRef?: ResourceRef;
  text: string;
  timezone?: string;
  replyTo?: string;
  observation?: Record<string, unknown>;
}
/** Routing state belongs to the consuming plugin; the Core persists it without interpreting destinations. */
export interface InputStatus {
  routing?: {
    phase: "running" | "done" | "ignored";
    /** Preserve the first-Conversation shortcut across a partial creation and restart. */
    bootstrap?: boolean;
    /** Stable identity for the one rule-created Conversation; uid pins its incarnation before append. */
    creation?: { sessionId: string; name: string; uid?: string };
    reason: string;
  };
}
