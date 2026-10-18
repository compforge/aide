import type { Aide } from "../../plugins/personal/aide.ts";
import { chiefTarget } from "../../plugins/personal/chief-model.ts";
import { PROTOCOL_VERSION, type BaseBlock, type ModelMeta, type UIModel } from "@compforge/agentue/ui";

export interface ConversationBlock extends BaseBlock {
  type: "message" | "execution" | "thought" | "text" | "tool";
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
 * @spec Live and historical progress share Ledger-backed Turn identity and remain scoped to the conversation's Chief target.
 * @why Completion folds execution details; it never deletes them or creates extra delivered Messages.
 * @link docs/web.md
 */
export function conversationView(aide: Aide, conversationId: string): ConversationView {
  const state = aide.channel.projection;
  const inputs = aide.store.conversations.inputs(conversationId);
  const active = inputs.find((input) => input.status.phase === "running" || input.status.phase === "waiting");
  const queued = inputs.filter((input) => !input.status.phase).length;
  const target = chiefTarget(conversationId);
  const turns = new Map([...state.harnessInputs.values()].filter((input) => input.harnessTargetId === target)
    .map((input) => [input.turnId, input]));
  const summaries = new Map(state.turnSummaries.filter((turn) => turn.harnessTargetId === target).map((turn) => [turn.turnId, turn]));
  const executions = new Map<string, { header: ConversationBlock; blocks: ConversationBlock[] }>();
  const roots: ConversationBlock[] = aide.messages().filter((message) => message.conversationId === conversationId)
    .map((message) => ({ id: `message:${message.id}`, type: "message", role: message.role, at: message.at, content: message.text }));
  const append = (turnId: string, block: ConversationBlock) => {
    const input = turns.get(turnId);
    if (!input) return;
    let execution = executions.get(turnId);
    if (!execution) {
      const summary = summaries.get(turnId);
      const live = state.activeTurns.has(turnId);
      const at = summary?.startedAt ?? state.messages.get(input.messageId)?.createdAt;
      execution = { header: { id: `execution:${turnId}`, type: "execution", content: "思考与执行过程", at,
        status: live ? "running" : summary?.stopReason === "end_turn" ? "completed" : "interrupted" }, blocks: [] };
      executions.set(turnId, execution); roots.push(execution.header);
    }
    execution.blocks.push({ ...block, parent_id: execution.header.id });
  };
  for (const item of state.timeline) {
    if (item.type === "message") {
      const message = state.messages.get(item.id);
      if (!message || message.kind !== "output" || !message.turnId || !turns.has(message.turnId)) continue;
      const text = message.content.map((part) => part.type === "text" ? part.text : "").join("");
      if (text) append(message.turnId, { id: `output:${message.messageId}`, type: message.role === "thought" ? "thought" : "text", content: text });
    } else if (item.type === "tool_call") {
      const tool = state.toolCalls.get(item.id);
      if (!tool?.turnId || !turns.has(tool.turnId)) continue;
      const args = tool.rawInput as Record<string, unknown> | undefined;
      const detail = args && [args.path, args.command, args.pattern].find((value) => typeof value === "string");
      append(tool.turnId, { id: `tool:${tool.toolCallId}`, type: "tool", content: tool.title ?? "工具调用", status: tool.status,
        ...(typeof detail === "string" ? { detail: detail.slice(0, 2000) } : {}) });
    }
  }
  const children = new Map([...executions.values()].map((execution) => [execution.header.id, execution.blocks]));
  const blocks = roots.sort((a, b) => (a.at ?? "").localeCompare(b.at ?? ""))
    .flatMap((block) => [block, ...children.get(block.id) ?? []]);
  const live = [...executions.values()].some((execution) => execution.header.status === "running");
  return {
    version: PROTOCOL_VERSION, biz: "aide.conversation", blocks,
    meta: { conversation_id: conversationId, activity: active || queued || live ? {
      id: active?.metadata.name ?? `queued:${conversationId}`, phase: active?.status.phase ?? "queued", queued,
    } : null },
  };
}


export interface ConversationSummary {
  id: string;
  title: string;
  preview: string;
  updatedAt: string;
}

/**
 * @spec Navigation includes Channel/Source conversations and work-only scopes; summaries never expose input prompts or execution details.
 * @link docs/web.md
 */
export function conversationList(aide: Aide): ConversationSummary[] {
  const summaries = new Map<string, ConversationSummary>();
  const ensure = (id: string) => {
    let summary = summaries.get(id);
    if (!summary) {
      summary = { id, title: id === "me" ? "默认对话" : id, preview: "", updatedAt: "" };
      summaries.set(id, summary);
    }
    return summary;
  };
  for (const conversation of aide.store.conversations.list()) ensure(conversation.id).updatedAt = conversation.createdAt;
  for (const input of aide.store.conversations.inputs()) {
    const summary = ensure(input.spec.conversationId);
    if (input.metadata.creationTimestamp > summary.updatedAt) summary.updatedAt = input.metadata.creationTimestamp;
  }
  for (const work of aide.store.read().works) ensure(work.conversationId);
  const titled = new Set<string>();
  for (const message of aide.messages()) {
    const summary = ensure(message.conversationId);
    const text = message.text.replace(/\s+/g, " ").trim();
    if (message.role === "user" && text && !titled.has(summary.id)) {
      summary.title = text.slice(0, 40); titled.add(summary.id);
    }
    // Messages are chronological; preview remains the latest delivered message even after a quiet Source input.
    summary.preview = text.slice(0, 100);
    if (message.at > summary.updatedAt) summary.updatedAt = message.at;
  }
  return [...summaries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
