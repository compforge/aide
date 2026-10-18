import type { Aide } from "../../plugins/personal/aide.ts";
import { chiefTarget } from "../../plugins/personal/chief-model.ts";
import { PROTOCOL_VERSION, type BaseBlock, type ModelMeta, type UIModel } from "@compforge/agentue/ui";

export interface ConversationBlock extends BaseBlock {
  type: "message" | "thought" | "text" | "tool";
  content: string;
  role?: "user" | "aide";
  at?: string;
  status?: string;
  detail?: string;
}
interface ConversationMeta extends ModelMeta {
  conversation_id: string;
  activity: { id: string; phase: string; queued: number } | null;
}
export type ConversationView = UIModel<ConversationBlock, ConversationMeta>;

/**
 * @spec Live progress is a conversation-scoped projection, never a delivered Message or a Work mutation.
 * @why The same Core reducer supplies live/replayed output; reconnecting replaces the view instead of replaying actions.
 * @link docs/web-progress.md
 */
export function conversationView(aide: Aide, conversationId: string): ConversationView {
  const state = aide.channel.projection;
  const inputs = aide.store.conversations.inputs(conversationId);
  const active = inputs.find((input) => input.status.phase === "running" || input.status.phase === "waiting");
  const queued = inputs.filter((input) => !input.status.phase).length;
  const turns = new Set([...state.activeTurns.values()]
    .filter((turn) => turn.harnessTargetId === chiefTarget(conversationId)).map((turn) => turn.turnId));
  const blocks: ConversationBlock[] = aide.messages().filter((message) => message.conversationId === conversationId)
    .map((message) => ({ id: `message:${message.id}`, type: "message", role: message.role, at: message.at, content: message.text }));
  for (const item of state.timeline) {
    if (item.type === "message") {
      const message = state.messages.get(item.id);
      if (!message || message.kind !== "output" || !message.turnId || !turns.has(message.turnId)) continue;
      const text = message.content.map((part) => part.type === "text" ? part.text : "").join("");
      if (text) blocks.push({ id: `output:${message.messageId}`, type: message.role === "thought" ? "thought" : "text", content: text });
    } else if (item.type === "tool_call") {
      const tool = state.toolCalls.get(item.id);
      if (!tool?.turnId || !turns.has(tool.turnId)) continue;
      const args = tool.rawInput as Record<string, unknown> | undefined;
      const detail = args && [args.path, args.command, args.pattern].find((value) => typeof value === "string");
      blocks.push({ id: `tool:${tool.toolCallId}`, type: "tool", content: tool.title ?? "工具调用", status: tool.status,
        ...(typeof detail === "string" ? { detail: detail.slice(0, 2000) } : {}) });
    }
  }
  return {
    version: PROTOCOL_VERSION, biz: "aide.conversation", blocks,
    meta: { conversation_id: conversationId, activity: active || queued || turns.size ? {
      id: active?.metadata.name ?? `queued:${conversationId}`, phase: active?.status.phase ?? "queued", queued,
    } : null },
  };
}
