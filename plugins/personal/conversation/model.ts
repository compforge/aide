import type { ResourceContext } from "../context.ts";
import type { Resource, Address } from "@compforge/aide-plugin";
import type { InputSpec, InputStatus } from "../input/model.ts";
import type { OutputView } from "../../../src/output.ts";
import type { LoopExecution } from "../loop.ts";
import type { ConversationTrigger } from "./trigger.ts";
export const CONVERSATION_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Conversation" } as const;
export interface ConversationSpec { address?: Address; id: string; name?: string; default?: boolean; trigger?: ConversationTrigger }
export interface ConversationStatus extends ResourceContext {
  nextTriggerAt?: string | null;
  execution?: LoopExecution | null;
  receipts: Array<{ key: string; responseId: string }>;
}
export type ConversationResource = Resource<ConversationSpec, ConversationStatus>;
export type ConversationDeletion = { deleted: true } | { deleted: false; reason: "missing" | "changed" | "busy" | "work" };
export interface Conversation extends ConversationSpec {
  revision: number; createdAt: string; pendingInputIds: string[]; outputs: OutputView[];
}
/** Presentation only: never overwrite an Input's resource version or routing status with Conversation state. */
export interface Consumption { phase?: "running" | "done" | "failed"; executionId?: string; summary?: string; error?: string }
export type ConversationInput = Resource<InputSpec, InputStatus> & { conversationId: string; consumption: Consumption };
export interface ConversationRun { id: string; conversationId: string; input?: ConversationInput; status: Consumption }
export function initialConversationName(text: string): string { return text.replace(/\s+/g, " ").trim().slice(0, 80); }
