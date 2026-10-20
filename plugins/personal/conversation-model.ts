import type { Resource } from "@compforge/aide-plugin";
import type { Message } from "./model.ts";
import type { InputSpec } from "@compforge/aide-plugin";
import type { ConversationTrigger } from "./conversation-trigger.ts";
export const CONVERSATION_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Conversation" } as const;
export interface ChiefQuestion { kind: "ask" | "confirm"; title: string; prompt: string; choices?: Array<{ value: string; label: string }> }
export interface ProcessingStatus {
  /** Timer activations have no Input; the deadline identifies one coalesced activation. */
  timerAt?: string; executionId?: string;
  phase?: "running" | "waiting" | "done" | "failed";
  laneId?: string; question?: ChiefQuestion | null; error?: string; quietReason?: string;
  messages?: Message[];
}
export interface ConversationSpec { id: string; name?: string; sessionId: string; inputIds: string[]; trigger?: ConversationTrigger }
export interface ConversationStatus {
  nextTriggerAt?: string | null;
  processing: Record<string, ProcessingStatus>;
  messages: Message[];
  receipts: Array<{ key: string; responseId: string }>;
}
export type ConversationResource = Resource<ConversationSpec, ConversationStatus>;
export interface Conversation extends ConversationSpec {
  revision: number; createdAt: string; pendingInputIds: string[]; messages: Message[];
}
export type ConversationInput = Resource<InputSpec, ProcessingStatus> & { conversationId: string };

export interface ConversationRun {
  id: string; conversationId: string; resourceVersion: string;
  input?: ConversationInput; status: ProcessingStatus;
}

/** @spec A Conversation keeps its initial name as later Inputs arrive. */
export function initialConversationName(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 80);
}

/** A Channel Input has one stable user-message identity in each receiving Conversation. */
export function inboundMessage(input: Resource<InputSpec, unknown>, conversationId: string): Message {
  return { id: `user:${input.metadata.name}:${conversationId}`, conversationId, at: input.metadata.creationTimestamp,
    role: "user", text: input.spec.text, workId: null };
}
