import type { Aide } from "../../plugins/personal/aide.ts";
import { chiefTarget } from "../../plugins/personal/chief-model.ts";

export interface ActivityBlock {
  id: string;
  kind: "thought" | "text" | "tool";
  text: string;
  status?: string;
  detail?: string;
}

/**
 * @spec Live progress is a conversation-scoped projection, never a delivered Message or a Work mutation.
 * @why The same Core reducer supplies live/replayed output; reconnecting replaces the view instead of replaying actions.
 * @link docs/web-progress.md
 */
export function conversationView(aide: Aide, conversationId: string) {
  const state = aide.channel.projection;
  const inputs = aide.store.conversations.inputs(conversationId);
  const active = inputs.find((input) => input.status.phase === "running" || input.status.phase === "waiting");
  const queued = inputs.filter((input) => !input.status.phase).length;
  const turns = new Set([...state.activeTurns.values()]
    .filter((turn) => turn.harnessTargetId === chiefTarget(conversationId)).map((turn) => turn.turnId));
  const blocks: ActivityBlock[] = [];
  for (const item of state.timeline) {
    if (item.type === "message") {
      const message = state.messages.get(item.id);
      if (!message || message.kind !== "output" || !message.turnId || !turns.has(message.turnId)) continue;
      const text = message.content.map((part) => part.type === "text" ? part.text : "").join("");
      if (text) blocks.push({ id: message.messageId, kind: message.role === "thought" ? "thought" : "text", text });
    } else if (item.type === "tool_call") {
      const tool = state.toolCalls.get(item.id);
      if (!tool?.turnId || !turns.has(tool.turnId)) continue;
      const args = tool.rawInput as Record<string, unknown> | undefined;
      const detail = args && [args.path, args.command, args.pattern].find((value) => typeof value === "string");
      blocks.push({ id: tool.toolCallId, kind: "tool", text: tool.title ?? "工具调用", status: tool.status,
        ...(typeof detail === "string" ? { detail: detail.slice(0, 2000) } : {}) });
    }
  }
  return {
    messages: aide.messages().filter((message) => message.conversationId === conversationId),
    activity: active || queued || turns.size ? {
      id: active?.metadata.name ?? `queued:${conversationId}`,
      phase: active?.status.phase ?? "queued", queued, blocks,
    } : null,
  };
}
