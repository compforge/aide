import { isChannelAddress } from "./address.ts";
import { channelOutputs, visibleOutput } from "./output.ts";
import { inputPrinter } from "../../plugins/personal/input/printer.ts";
import { iconFor } from "@compforge/aide-plugin";
import { harnessIdentityFor } from "../host/harness/ids.ts";
import { conversationTrigger, type ConversationTrigger } from "../../plugins/personal/conversation/trigger.ts";
import type { ChannelService } from "./service.ts";
import { PROTOCOL_VERSION, type BaseBlock, type ModelMeta, type UIModel } from "@compforge/agentue/ui";

export interface ConversationBlock extends BaseBlock {
  type: "summary" | "input" | "message" | "execution" | "thought" | "text" | "tool";
  content: string;
  role?: "user" | "aide";
  at?: string;
  status?: string;
  detail?: string;
  inputId?: string;
  origin?: "channel" | "source";
  originId?: string;
  relation?: import("../../plugins/personal/input/model.ts").InputRelation;
  sender?: import("@compforge/aide-plugin").ResourceRef;
  receivers?: import("@compforge/aide-plugin").ResourceRef[];
  source?: import("@compforge/aide-plugin").Address;
  target?: import("@compforge/aide-plugin").Address;
  label?: string;
  icon?: string;
  harness?: string;
}
interface ConversationMeta extends ModelMeta {
  conversation_id: string;
  activity: { id: string; phase: string; queued: number } | null;
}
export type ConversationView = UIModel<ConversationBlock, ConversationMeta>;

/**
 * @spec Live and historical progress share Ledger-backed Turn identity and use the explicit execution conversation association.
 * @spec AgentUE group_id binds executions and official replies to their persisted Chief activation.
 * @spec Every Channel or Source Input attached to this Conversation stays visible, including queued and quietly consumed observations.
 * @spec Input cards and Harness identity project persisted facts without creating outbound Messages.
 * @case tests/web-progress.test.ts
 * @spec Questions retain their Core identity and state; they never become final-answer text.
 * @why Completion folds execution details; it never deletes them or creates extra delivered Messages.
 * @link docs/channel/web.md
 */
export function conversationView(aide: ChannelService, conversationId: string): ConversationView {
  if (!aide.conversations.get(conversationId)) return { version: PROTOCOL_VERSION, biz: "aide.conversation", blocks: [], meta: { conversation_id: conversationId, activity: null } };
  const history = aide.invocations().filter(item => item.conversationId === conversationId);
  const state = aide.runtime.executions.view(history.flatMap(item => item.invocationId ? [item.invocationId] : []));
  const runs = aide.conversations.runs(conversationId);
  const active = runs.find((input) => !input.input && input.status.phase === "running");
  const queued = runs.filter((input) => !input.status.phase).length;
  const runId = (item: { inputId?: string; executionId: string }) => item.executionId;
  const resource = aide.conversations.resource(conversationId);
  const turnInputs = new Map([...state.harnessInputs.values()].map((input) => [input.invocationId, input]));
  const invocations = history.filter((item) => {
    if (item.conversationId !== conversationId || !resource) return false;
    if (item.resourceRef?.kind === "Conversation") return item.resourceRef.uid === resource.metadata.uid;
    // Deleted Work may retain progress in its original Conversation, never in a later incarnation.
    const input = item.invocationId && turnInputs.get(item.invocationId);
    const at = input && state.messages.get(input.messageId)?.createdAt;
    return !at || at >= resource.metadata.creationTimestamp;
  });
  const relatedTurns = new Set(invocations.map((item) => item.invocationId));
  // Group presentation by persisted Chief activation, never by message order or similar text.
  const turnRuns = new Map(invocations.map((item) => [item.invocationId, runId(item)]));
  const runPhases = new Map(runs.map((input) => [input.id, input.status.phase]));
  const messageRuns = new Map<string, string>();
  for (const message of channelOutputs(aide)) if (message.executionId) messageRuns.set(message.id, message.executionId);
  const inputExecutions = new Map(invocations.flatMap((i) => (i.inputIds ?? []).map((id) => [id, i.executionId] as const)));
  const turns = new Map([...state.harnessInputs.values()].filter((input) => relatedTurns.has(input.invocationId))
    .map((input) => [input.invocationId, input]));
  const summaries = new Map(state.invocationSummaries.filter((turn) => relatedTurns.has(turn.invocationId)).map((turn) => [turn.invocationId, turn]));
  const executions = new Map<string, { header: ConversationBlock; blocks: ConversationBlock[] }>();
  const roots: ConversationBlock[] = channelOutputs(aide).filter((message) => resource && visibleOutput(message, resource))
    .map((message) => ({ id: `message:${message.id}`, type: "message", role: message.role, at: message.at, content: message.text, receivers: message.receivers, target: message.target,
      ...(messageRuns.has(message.id) ? { group_id: messageRuns.get(message.id), status: runPhases.get(messageRuns.get(message.id)!) } : {}),
    }));
  if (resource?.status.summary) roots.push({ id: "conversation-summary", type: "summary", label: "历史摘要", icon: "📝",
    content: resource.status.summary!, at: resource.metadata.creationTimestamp });
  for (const run of runs) {
    if (!run.input) continue;
    const input = run.input, definition = aide.inputDefinition(input.spec);
    roots.push({ id: `input:${input.metadata.name}`, type: "input", relation: input.spec.relation, sender: input.spec.sender, source: input.spec.source, origin: input.spec.origin, originId: definition.id,
      inputId: input.metadata.name, group_id: inputExecutions.get(input.metadata.name) ?? input.consumption.executionId ?? input.metadata.name, label: definition.label, icon: definition.icon,
      ...(input.spec.origin === "channel" ? { role: "user" as const } : {}),
      at: input.metadata.creationTimestamp, content: input.spec.text,
      status: run.status.phase ?? "queued",
      detail: [inputPrinter.describe(input), run.status.summary, run.status.error].filter(Boolean).join("\n\n") });
  }
  const append = (turnId: string, block: ConversationBlock) => {
    const input = turns.get(turnId);
    if (!input) return;
    let execution = executions.get(turnId);
    if (!execution) {
      const summary = summaries.get(turnId);
      const live = state.activeInvocations.has(turnId);
      const at = summary?.startedAt ?? state.messages.get(input.messageId)?.createdAt;
      const harness = summary?.harness ?? input.harness;
      if (!harness) throw new Error(`Turn ${turnId} is missing its Harness identity`);
      const identity = harnessIdentityFor(harness);
      execution = { header: { id: `execution:${turnId}`, type: "execution", content: "过程", at, group_id: turnRuns.get(turnId),
        status: live ? "running" : summary?.stopReason === "end_turn" ? "completed" : "interrupted",
        harness, label: identity?.label ?? harness, icon: identity?.icon ?? iconFor(`harness:${harness}`) }, blocks: [] };
      executions.set(turnId, execution); roots.push(execution.header);
    }
    execution.blocks.push({ ...block, parent_id: execution.header.id });
  };
  for (const item of state.timeline) {
    if (item.type === "message") {
      const message = state.messages.get(item.id);
      if (!message || message.kind !== "output" || !message.invocationId || !turns.has(message.invocationId)) continue;
      const text = message.content.map((part) => part.type === "text" ? part.text : "").join("");
      if (text) append(message.invocationId, { id: `output:${message.messageId}`, type: message.role === "thought" ? "thought" : "text", content: text,
        ...(message.phase ? { phase: message.phase } : {}) });
    } else if (item.type === "tool_call") {
      const tool = state.toolCalls.get(item.id);
      if (!tool?.invocationId || !turns.has(tool.invocationId)) continue;
      const args = tool.rawInput as Record<string, unknown> | undefined;
      const detail = args && [args.path, args.command, args.pattern].find((value) => typeof value === "string");
      append(tool.invocationId, { id: `tool:${tool.toolCallId}`, type: "tool", content: tool.title ?? "工具调用", status: tool.status,
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
      id: active?.id ?? `queued:${conversationId}`, phase: active?.status.phase ?? "queued", queued,
    } : null },
  };
}


export interface ConversationSummary {
  id: string;
  revision: number | null;
  uid: string | null;
  sessionId: string;
  trigger: ConversationTrigger;
  default: boolean;
  name: string;
  preview: string;
  updatedAt: string;
}

/**
 * @spec Navigation includes Channel/Source conversations and work-only scopes; summaries expose the Conversation name and delivered preview, without other input prompts or execution details.
 * @link docs/channel/web.md
 */
export function conversationList(aide: ChannelService): ConversationSummary[] {
  const summaries = new Map<string, ConversationSummary>();
  const ensure = (id: string) => {
    let summary = summaries.get(id);
    if (!summary) {
      const resource = aide.conversations.resource(id);
      summary = { id, uid: resource?.metadata.uid ?? null, revision: aide.conversations.get(id)?.revision ?? null,
        sessionId: id, trigger: conversationTrigger(resource?.spec.trigger),
        default: resource?.spec.default === true && !resource.metadata.deletionTimestamp,
        name: aide.conversations.get(id)?.name || "未命名会话", preview: "", updatedAt: "" };
      summaries.set(id, summary);
    }
    return summary;
  };
  for (const conversation of aide.conversations.list()) ensure(conversation.id).updatedAt = conversation.createdAt;
  for (const input of aide.conversations.inputs()) {
    const summary = ensure(input.conversationId);
    if (input.metadata.creationTimestamp > summary.updatedAt) summary.updatedAt = input.metadata.creationTimestamp;
  }
  for (const id of aide.conversationIds()) ensure(id);
  for (const message of channelOutputs(aide)) {
    const destinations = new Set([message.conversationId]);
    if (isChannelAddress(message.target) && message.target.channelId === "web") destinations.add(message.target.endpoint);
    for (const id of destinations) {
      const current = aide.conversations.resource(id);
      if (!current || !visibleOutput(message, current)) continue;
      const summary = ensure(id);
      const text = message.text.replace(/\s+/g, " ").trim();
      // Messages are chronological; quiet Source inputs do not erase the latest reply preview.
      summary.preview = text.slice(0, 100);
      if (message.at > summary.updatedAt) summary.updatedAt = message.at;
    }
  }
  return [...summaries.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
