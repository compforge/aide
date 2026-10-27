import { topicSubtree } from "../../plugins/personal/topic/tree.ts";
import { TOPIC_TYPE, type TopicResource } from "../../plugins/personal/topic/model.ts";
import { channelOutputs, visibleOutput } from "./output.ts";
import { inputPrinter } from "../../plugins/personal/input/printer.ts";
import { iconFor } from "@compforge/aide-plugin";
import { harnessIdentityFor } from "../host/harness/ids.ts";
import type { ChannelService } from "./service.ts";
import type { ResourceContext } from "../../plugins/personal/context.ts";
import { PROTOCOL_VERSION, type BaseBlock, type ModelMeta, type UIModel } from "@compforge/agentue/ui";

export interface TopicBlock extends BaseBlock {
  type: "summary" | "input" | "message" | "execution" | "thought" | "text" | "tool";
  content: string;
  role?: "user" | "aide";
  at?: string;
  status?: string;
  detail?: string;
  inputId?: string;
  origin?: "channel" | "source" | "chief" | "trigger";
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
interface TopicMeta extends ModelMeta {
  topic_id: string;
  context: ResourceContext | null;
  activity: { id: string; phase: string; queued: number } | null;
}
export type TopicView = UIModel<TopicBlock, TopicMeta>;

/**
 * @spec Retained live progress uses explicit invocation and Topic associations; it does not survive service restart.
 * @spec AgentUE group_id binds executions and official replies to their persisted Chief activation.
 * @spec Every Channel or Source Input attached to this Topic stays visible, including queued and quietly consumed observations.
 * @spec Input cards and Harness identity project persisted facts without creating outbound Messages.
 * @case tests/web-progress.test.ts
 * @spec Questions are ordinary Outputs; native permissions use a separate Approval surface.
 * @why Completion folds execution details; it never deletes them or creates extra delivered Messages.
 * @link docs/channel/web.md
 */
export function topicView(aide: ChannelService, topicId: string): TopicView {
  if (!aide.topics.get(topicId)) return { version: PROTOCOL_VERSION, biz: "aide.topic", blocks: [], meta: { topic_id: topicId, context: null, activity: null } };
  const resource = aide.topics.resource(topicId)!;
  const members = topicSubtree(aide.topics.resources.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE), resource);
  const memberIds = new Set(members.map(t => t.spec.id)), memberUids = new Set(members.map(t => t.metadata.uid));
  const inputIds = new Set(aide.topics.inputs(topicId).map(i => i.metadata.name));
  const history = aide.invocations().filter(item => memberIds.has(item.topicId ?? "") || item.inputIds?.some(id => inputIds.has(id)));
  const state = aide.runtime.executions.view(history.flatMap(item => item.invocationId ? [item.invocationId] : []));
  const runs = aide.topics.runs(topicId);
  const active = runs.find((input) => !input.input && input.status.phase === "running");
  const queued = runs.filter((input) => !input.status.phase).length;
  const runId = (item: { inputId?: string; executionId: string }) => item.executionId;
  const turnInputs = new Map([...state.harnessInputs.values()].map((input) => [input.invocationId, input]));
  const invocations = history.filter((item) => {
    if (item.inputIds?.some(id => inputIds.has(id))) return true;
    if (!memberIds.has(item.topicId ?? "")) return false;
    if (item.resourceRef?.kind === "Topic") return memberUids.has(item.resourceRef.uid ?? "");
    // Deleted Work may retain progress in its original Topic, never in a later incarnation.
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
  // Native notifications provide explicit transient links for steered/follow-up material; Input itself owns no Chief invocation.
  const facts = aide.topics.inputs(topicId);
  for (const notification of state.harnessInputs.values()) {
    const invocation = invocations.find(i => i.invocationId === notification.invocationId && i.resourceRef?.kind === "Topic");
    if (!invocation || notification.deliveryOutcome === "failed") continue;
    const fact = facts.find(i => notification.messageId === `input:${i.metadata.uid}:${invocation.resourceRef!.uid}`);
    if (fact) inputExecutions.set(fact.metadata.name, invocation.executionId);
  }
  const turns = new Map([...state.harnessInputs.values()].filter((input) => relatedTurns.has(input.invocationId))
    .map((input) => [input.invocationId, input]));
  const summaries = new Map(state.invocationSummaries.filter((turn) => relatedTurns.has(turn.invocationId)).map((turn) => [turn.invocationId, turn]));
  const executions = new Map<string, { header: TopicBlock; blocks: TopicBlock[] }>();
  const roots: TopicBlock[] = channelOutputs(aide).filter((message) => resource && (visibleOutput(message, resource) || memberUids.has(message.topicUid) || message.inputIds?.some(id => inputIds.has(id))))
    .map((message) => ({ id: `message:${message.id}`, type: "message", role: message.role, at: message.at, content: message.text, receivers: message.receivers, target: message.target,
      ...(messageRuns.has(message.id) ? { group_id: messageRuns.get(message.id), status: runPhases.get(messageRuns.get(message.id)!) } : {}),
    }));
  if (resource?.status.summary) roots.push({ id: "topic-summary", type: "summary", label: "历史摘要", icon: "📝",
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
  const append = (turnId: string, block: TopicBlock) => {
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
    version: PROTOCOL_VERSION, biz: "aide.topic", blocks,
    meta: { topic_id: topicId, context: resource ? { summary: resource.status.summary, recent: resource.status.recent } : null, activity: active || queued || live ? {
      id: active?.id ?? `queued:${topicId}`, phase: active?.status.phase ?? "queued", queued,
    } : null },
  };
}
