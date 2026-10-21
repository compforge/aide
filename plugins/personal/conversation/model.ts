import type { InputSpec, InputStatus, Resource } from "@compforge/aide-plugin";
import type { Message } from "../model.ts";
import type { Batch } from "./batch.ts";
import type { ConversationTrigger } from "./trigger.ts";
export const CONVERSATION_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Conversation" } as const;
export interface ChiefQuestion { kind: "ask" | "confirm"; title: string; prompt: string; choices?: Array<{ value: string; label: string }> }
export interface ConversationSpec { id: string; name?: string; default?: boolean; sessionId: string; trigger?: ConversationTrigger }
export interface ConversationStatus {
  pendingInputIds: string[];
  nextTriggerAt?: string | null;
  batch?: Batch | null;
  messages: Message[];
  receipts: Array<{ key: string; responseId: string }>;
}
export type ConversationResource = Resource<ConversationSpec, ConversationStatus>;
export type ConversationDeletion = { deleted: true } | { deleted: false; reason: "missing" | "changed" | "busy" | "work" };
export const conversationLane = (c: Readonly<ConversationResource>): string => `chief:${c.metadata.uid}`;
export interface Conversation extends ConversationSpec {
  revision: number; createdAt: string; pendingInputIds: string[]; messages: Message[];
}
/** Presentation only: never overwrite an Input's resource version or routing status with Conversation state. */
export interface Consumption { phase?: Batch["phase"]; batchId?: string; executionId?: string; quietReason?: string; messages?: Message[] }
export type ConversationInput = Resource<InputSpec, InputStatus> & { conversationId: string; consumption: Consumption };
export interface ConversationRun { id: string; conversationId: string; input?: ConversationInput; status: Consumption }
export function initialConversationName(text: string): string { return text.replace(/\s+/g, " ").trim().slice(0, 80); }
