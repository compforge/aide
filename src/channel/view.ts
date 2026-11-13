import { outputWaitLabels } from "../../plugins/personal/output/view.ts";
import { topicHistory, type HistorySelection } from "../../plugins/personal/topic/history.ts";
import { outputView } from "../../plugins/personal/output/view.ts";
import { iconFor } from "@compforge/aide-plugin";
import { harnessIdentityFor } from "../host/harness/ids.ts";
import type { ChannelService } from "./service.ts";
import { PROTOCOL_VERSION, type BaseBlock, type ModelMeta, type UIModel } from "@compforge/agentue/ui";

export interface TopicBlock extends BaseBlock {
  type: "summary" | "input" | "message" | "execution" | "thought" | "text" | "tool";
  content: string;
  role?: "user" | "aide";
  at?: string;
  status?: string;
  detail?: string;
  inputId?: string;
  origin?: "channel" | "source" | "chief" | "aide:review" | "aide:triage" | "aide:organize";
  originId?: string;
  relation?: import("../../plugins/personal/input/model.ts").InputRelation;
  sender?: import("@compforge/aide-plugin").ResourceRef;
  receivers?: import("@compforge/aide-plugin").ResourceRef[];
  source?: import("../../plugins/personal/address/model.ts").AddressRef;
  target?: import("@compforge/aide-plugin").Address;
  label?: string;
  icon?: string;
  harness?: string;
  lazy?: { topicUid: string; uid: string; version: string };
}
interface TopicMeta extends ModelMeta {
  topic_id: string;
  before?: string | null;
  activity: { id: string; phase: string; queued: number; error?: string } | null;
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
export function topicView(aide: ChannelService, topicId: string, before?: string, selection: HistorySelection = {}): TopicView {
  const resource = aide.topics.resource(topicId);
  if (!resource) return { version: PROTOCOL_VERSION, biz: "aide.topic", blocks: [], meta: { topic_id: topicId, before: null, activity: null } };
  const members = aide.topics.scope(resource.metadata.uid);
  const memberIds = new Set(members.map(t => t.spec.id)), memberUids = new Set(members.map(t => t.metadata.uid));
  const active = !before && !selection.message ? resource.status.execution : undefined;
  const allInvocations = aide.invocations();
  const liveExecutions = new Set(!before ? allInvocations.filter(item => item.phase === "running" && memberIds.has(item.topicId ?? ""))
    .map(item => item.executionId) : []);
  if (active) liveExecutions.add(active.id);
  const page = topicHistory(aide.topics, resource, members, before, { ...selection, liveExecutions });
  const messages = page.outputs.map(output => outputView(output, aide.topics.outputStore.streams));
  const inputIds = new Set(page.items.filter(i => i.type === "input").map(i => i.id.slice(6)));
  const executionIds = new Set([...messages.flatMap(m => m.executionId ? [m.executionId] : []),
    ...page.inputs.flatMap(i => [i.status.assess?.completedBy?.executionId, i.status.assess?.executionId].filter((id): id is string => !!id))]);
  const history = allInvocations.filter(item => (!selection.summaries || liveExecutions.has(item.executionId)) &&
    (item.inputIds?.some(id => inputIds.has(id)) || executionIds.has(item.executionId)
    || (!before && !selection.message && memberIds.has(item.topicId ?? "") && (item.executionId === active?.id || item.phase === "running" || !item.inputIds?.length))));
  const state = aide.runtime.executions.view(history.flatMap(item => item.invocationId ? [item.invocationId] : []));
  const queued = before ? 0 : page.queued;
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
  const runPhases = new Map<string, string>(active ? [[active.id, "running"]] : []);
  const messageRuns = new Map<string, string>();
  for (const message of messages) if (message.executionId) messageRuns.set(message.id, message.executionId);
  const inputExecutions = new Map(invocations.flatMap((i) => (i.inputIds ?? []).map((id) => [id, i.executionId] as const)));
  // Chief admission is persisted on Input, including steer/followUp and unconfirmed results.
  const turns = new Map([...state.harnessInputs.values()].filter((input) => relatedTurns.has(input.invocationId))
    .map((input) => [input.invocationId, input]));
  const summaries = new Map(state.invocationSummaries.filter((turn) => relatedTurns.has(turn.invocationId)).map((turn) => [turn.invocationId, turn]));
  const executions = new Map<string, { header: TopicBlock; blocks: TopicBlock[] }>();
  const roots: TopicBlock[] = messages.filter(message => message.text.trim() || message.generation === "open")
    .map((message) => ({ id: `message:${message.id}`, type: "message", role: message.role, at: message.at, content: message.text, label: outputLabel(message.status), detail: message.status.disclosure?.reason, receivers: message.receivers, target: message.target,
      ...(messageRuns.has(message.id) ? { group_id: messageRuns.get(message.id), status: runPhases.get(messageRuns.get(message.id)!) } : {}),
    }));
  for (const input of page.inputs) {
    const definition = aide.inputDefinition(input.spec);
    const receipt = input.status.assess;
    roots.push({ id: `input:${input.metadata.name}`, type: "input", relation: input.spec.relation, sender: input.spec.sender, source: input.spec.source, origin: input.spec.origin, originId: definition.id,
      inputId: input.metadata.name, group_id: receipt?.completedBy?.executionId ?? receipt?.executionId ?? inputExecutions.get(input.metadata.name) ?? input.metadata.name, label: definition.label, icon: definition.icon,
      ...(input.spec.origin === "channel" ? { role: "user" as const } : {}),
      at: input.metadata.creationTimestamp, content: input.spec.text,
      status: receipt?.completedAt ? "done" : "queued",
      detail: [receipt?.result?.summary, receipt?.lastError].filter(Boolean).join("\n\n") });
  }
  if (selection.summaries) for (const item of page.items) {
    if (roots.some(block => block.id === item.id)) continue;
    const definition = item.origin && aide.inputDefinition({ origin: item.origin, originId: item.originId ?? "" });
    roots.push({ id: item.id, type: item.type, at: item.at, content: item.preview,
      role: item.type === "message" ? "aide" : item.origin === "channel" ? "user" : undefined,
      status: item.status, group_id: item.executionId, origin: item.origin, originId: definition ? definition.id : undefined,
      ...(definition ? { label: definition.label, icon: definition.icon } : {}),
      ...(item.type === "input" ? { inputId: item.id.slice(6) } : {}),
      lazy: { topicUid: resource.metadata.uid, uid: item.uid, version: item.version } });
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
  const error = !before && !active && !live ? resource.status.lastError : undefined;
  return {
    version: PROTOCOL_VERSION, biz: "aide.topic", blocks,
    meta: { topic_id: topicId, before: page.before, activity: active || queued || live || error ? {
      id: active?.id ?? `queued:${topicId}`, phase: active ? "running" : error ? "failed" : "queued", queued, ...(error ? { error } : {}),
    } : null },
  };
}

function outputLabel(status: Pick<import("../../plugins/personal/output/model.ts").OutputStatus, "phase" | "lastError" | "disclosure" | "deliveryWait">): string | undefined {
  if (status.phase === "cancelled") return "已取消答复，尚未发送";
  if (status.phase === "uncertain") return "投递结果待确认";
  if (status.phase === "failed") return "投递失败";
  if (status.deliveryWait && ["pending", "sending"].includes(status.phase)) {
    const { reason, until } = status.deliveryWait, label = outputWaitLabels[reason];
    return reason === "receiver-busy" ? label : `${label}，预计 ${new Date(until).toLocaleString()} 重试`;
  }
  if (status.disclosure?.decision === "denied") return status.phase === "delivered" ? "已转告 Me，原目标未发送" : "原目标未发送，正在告知 Me";
  if (!status.disclosure) return "待检查，尚未发送";
  if (status.phase !== "delivered") return "尚未送达";
}
