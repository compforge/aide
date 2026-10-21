import type { Resource } from "@compforge/aide-plugin";
import type { Message } from "../model.ts";
import type { InputSpec } from "@compforge/aide-plugin";
import type { ConversationTrigger } from "./trigger.ts";
export const CONVERSATION_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Conversation" } as const;
export interface ChiefQuestion { kind: "ask" | "confirm"; title: string; prompt: string; choices?: Array<{ value: string; label: string }> }
export interface ProcessingStatus {
  /** A round owns execution; member Inputs point to it instead of carrying independent actions. */
  batchInputIds?: string[];
  roundId?: string;
  compacting?: boolean;
  summary?: string;
  notifications?: Array<{ id: string; text: string; sent?: boolean }>;
  /** A timer may activate an empty batch; this deadline identifies the coalesced review. */
  timerAt?: string;
  executionId?: string;
  phase?: "running" | "waiting" | "done" | "failed";
  laneId?: string; question?: ChiefQuestion | null; error?: string; quietReason?: string;
  messages?: Message[];
}
export interface ConversationSpec { id: string; name?: string; default?: boolean; sessionId: string; inputIds: string[]; trigger?: ConversationTrigger }
export interface ConversationStatus {
  nextTriggerAt?: string | null;
  summary?: { text: string; through: string; at: string };
  /** Partial summary keeps its original entry referenced until every character has been consumed. */
  compaction?: { entryId: string; offset: number; text: string } | null;
  contextReady?: boolean;
  blocked?: { at: string; reason: string } | null;
  processing: Record<string, ProcessingStatus>;
  messages: Message[];
  receipts: Array<{ key: string; responseId: string }>;
}
export type ConversationResource = Resource<ConversationSpec, ConversationStatus>;
export type ConversationDeletion = { deleted: true } | { deleted: false; reason: "missing" | "changed" | "busy" | "work" };

/** @spec Recreating a deleted Conversation starts a fresh native context; existing conversations retain their recorded Lane. */
export function conversationLane(conversation: Readonly<ConversationResource>): string {
  return Object.values(conversation.status.processing).find((run) => run.laneId)?.laneId ?? `chief:${conversation.metadata.uid}`;
}
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
