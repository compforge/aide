// Live Harness execution projection. Native histories are never replayed into it.

import type {
  AnyEventEnvelope,
  ApprovalReviewUpdate,
  AvailableCommand,
  ContentBlock,
  ContextWindowUpdate,
  ErrorUpdate,
  EventEnvelope,
  EventSource,
  HarnessInvocationCancelled,
  HarnessInvocationFailed,
  HarnessInvocationRecorded,
  HarnessTaskUpdate,
  MessageRole,
  Notice,
  PlanUpdate,
  PromptBlock,
  ProposedPlan,
  SessionConfigOption,
  SessionRunState,
  StopReason,
  ToolCallStatus,
  ToolEffect,
  InvocationSummary,
  UsageUpdate,
} from "../event/index.ts";
import {
  type HarnessInputSource,
  type HarnessInputStatus,
} from "../harness/input.ts";
import { harnessTaskKey } from "../harness/task.ts";
import { applyInputDelivery, applyMessageReplies, placeMessage, refreshConsumedSummary } from "../store/message-relations.ts";
import type { InputState, OutputState, InputRequestState, InputResponseState } from "../store/message-state.ts";
import { actorOf, HUMAN_ACTOR } from "../message/actor.ts";
import { inputMessage, inputRequestMessage, inputResponseMessage } from "../message/project.ts";
import { getMessage } from "../message/query.ts";
import { canResolveRequest } from "../approval/resolution.ts";

/** Content-specific index; getMessage also resolves requests and responses. */
export type MessageState = InputState | OutputState;

export interface ToolCallState {
  toolCallId: string;
  /** 产生该工具活动的 harness；多 harness 时间线展示归属时使用。 */
  harness?: string;
  /** 产生该工具活动的具体配置目标。 */
  harnessName?: string;
  runtimeId?: string;
  title?: string;
  kind?: string;
  /** 只读/副作用声明，由 adapter 上报；缺省 = 未知，消费方保守处理。 */
  effect?: ToolEffect;
  status: ToolCallStatus;
  content: ContentBlock[];
  locations: string[];
  rawInput?: unknown;
  rawOutput?: unknown;
  invocationId?: string;
}

export interface PlanState extends PlanUpdate {
  invocationId?: string;
  /** 产生该计划的 harness；pinned plan 只跟随当前输入目标。 */
  harness?: string;
  /** 产生该计划的具体配置目标。 */
  harnessName?: string;
  runtimeId?: string;
}

export interface ProposedPlanState extends ProposedPlan {
  harness?: string;
  harnessName?: string;
  runtimeId?: string;
  invocationId?: string;
  implementationTurnId?: string;
  implementationStartedAt?: string;
}

export interface HarnessTaskState extends HarnessTaskUpdate {
  /** Aide identity; taskId remains the Harness-native identity. */
  taskKey: string;
  harness?: string;
  harnessName?: string;
  harnessSessionId?: string;
  runtimeId?: string;
  invocationId?: string;
  /** First observed lifecycle edge; used only to render live elapsed time. */
  startedAt?: number;
}

/**
 * HarnessConfiguration-scoped 会话状态的统一槽位，键 = 事件信封 `harnessName`。
 * `harness` 只描述协议/Adapter 类型，不能作为状态实例的查询键：同一种 Harness
 * 可以有多个 Target。新增“每个 Target 各有一份”的状态时统一加在这里。
 */
export interface HarnessConfigurationState {
  /** 该 Target 使用的 Harness 协议类型；仅供展示和能力解释。 */
  harness?: string;
  /** 最近 context 占用快照（整体替换）。带 model 标签：切 model 后旧快照按标签判失效 */
  /** 最近一次严格配对的 model route context window 快照。 */
  contextWindow?: ContextWindowUpdate;
  /** 该 Target 最近一次 plan 的 id（plan 本体在 plans）。 */
  lastPlanId?: string;
  /** 该 Target 最近一次可用命令完整快照。 */
  availableCommands: AvailableCommand[];
  /** 该 Target 最近一次配置项完整快照。 */
  configOptions: SessionConfigOption[];
}

export type ContextTargetState = HarnessConfigurationState;

/** Transcript read-model order: outputs on first observation, pending inputs only at consumption. */
export interface TimelineItem {
  type: "message" | "tool_call" | "plan" | "proposed_plan" | "task" | "notice" | "approval_review" | "error" | "harness_invocation";
  id: string;
}

export interface InvocationSummaryState extends InvocationSummary {
  /** A late consumption fact can enrich the read model without rewriting the summary Event. */
  updatedSeq?: number;
  harness?: string;
  harnessName?: string;
  runtimeId?: string;
}

export interface HarnessInvocationState {
  invocationId: string;
  verb: HarnessInvocationRecorded["verb"];
  title: string;
  pluginInstanceId?: string;
  phase:
    | "queued"
    | "running"
    | "uncertain"
    | "completed"
    | "cancelled"
    | "failed";
  harnessName?: string;
  runtimeId: string;
  messageId?: string;
  attemptId?: string;
  result?: InvocationSummaryState;
  cancellation?: HarnessInvocationCancelled;
  failure?: HarnessInvocationFailed;
}

export interface UsageTotal {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  hasEstimated: boolean;
}

/** 一个仍在运行的 turn 的投影状态（running 开界、本 turn idle 收界） */
export interface ActiveInvocationState {
  invocationId: string;
  harness?: string;
  harnessName?: string;
  runtimeId?: string;
  /** 本 turn 当前非 idle 态（running / requires_action）：保真透传，不折叠成 running */
  state: Exclude<SessionRunState, "idle">;
  startedAt?: number;
  /** per-turn 运行阶段（compacting…）：null phase 或本 turn idle 清除（阶段不跨 turn） */
  phase?: { phase: string; title?: string };
}

export interface ApprovalState {
  request: InputRequestState;
  /** Execution/recovery correlation, deliberately outside the public Message. */
  requestedEventId: string;
}

export interface HarnessInputState {
  messageId: string;
  invocationId: string;
  harnessName: string;
  runtimeId: string;
  harness?: string;
  status: HarnessInputStatus;
  delivery: "prompt" | "steer" | "followUp";
  deliveryOutcome?: "applied" | "failed" | "uncertain";
  blocks: PromptBlock[];
  source: HarnessInputSource;
  harnessInvocationId?: string;
}

export interface HarnessState {
  /** 派生值：pending Approval 或任一 turn requires_action ⇒ requires_action；activeTurns 空 ⇒ idle；否则 running。 */
  runState: SessionRunState;
  lastStopReason?: StopReason;
  /**
   * running 且尚未收到本 turn idle 的 turns。并发 Turn 各占一席，
   * 任何一个收口只清自己——busy/流式/运行行等呈现一律从这里聚合派生。
   */
  activeInvocations: Map<string, ActiveInvocationState>;
  /** per-turn 终态 stopReason：并发 turn 交错收口时按 turn 取值，不共享单槽 */
  stopReasons: Map<string, StopReason>;
  timeline: TimelineItem[];
  messages: Map<string, MessageState>;
  /**
   * 全部 HarnessInput 的投影（含终态）：Queue 区与 Transcript 的单源。
   * steer 投递结果在 deliveryOutcome，与调度 status 正交（回执可迟到于 Turn 收口）。
   */
  harnessInputs: Map<string, HarnessInputState>;
  toolCalls: Map<string, ToolCallState>;
  plans: Map<string, PlanState>;
  /** 已完成、尚未表示执行授权的计划提案；按 planId 首写即定。 */
  proposedPlans: Map<string, ProposedPlanState>;
  /** Harness 已启动的异步任务 / subagent，按 provider task id upsert。 */
  tasks: Map<string, HarnessTaskState>;
  /** Pending-request index and its terminal result; request identity is a Message identity. */
  approvals: Map<string, ApprovalState>;
  inputResponses: Map<string, InputResponseState>;
  /**
   * auto-review 回执，按回执自身的 `reviewId` 归档（见 docs/approval-lifecycle.md）。与原生审批
   * 正交：这是“已被 reviewer 决策”的留痕，不是待决，不派生 requires_action。每条回执是
   * timeline 的一等公民（首见即入 timeline），无 target 也留痕、同一操作多次决策各自成条。
   */
  approvalReviews: Map<string, ApprovalReviewUpdate & { invocationId?: string }>;
  /** Compact cards for non-user Turn initiation; raw events retain their resource context. */
  harnessInvocations: Map<string, HarnessInvocationState>;
  usage: UsageTotal;
  /** Target-scoped 状态统一入口；Harness 类型不是状态实例的查询键。 */
  perTarget: Map<string, HarnessConfigurationState>;
  /** Context × Target 原生 binding 状态。 */
  perContextTarget: Map<string, ContextTargetState>;
  /** 最近一次结构化错误；willRetry 时 runState 仍应为 running（由事件源保证） */
  lastError?: ErrorUpdate & { seq: number; runtimeId?: string; invocationId?: string };
  /**
   * 错误历史（append-only），同时进 timeline（id 为 `err_<seq>`）：
   * 启动失败、admission 错误、quota 耗尽等属于会话流的一部分，要按发生位置内联展示。
   */
  errors: Map<string, ErrorUpdate & { seq: number; runtimeId?: string; invocationId?: string }>;
  /**
   * 提示历史（append-only），同时进 timeline（id 为 `n_<seq>`）：打断标记、
   * harness warning 等属于会话流的一部分，要按发生位置内联展示。
   */
  notices: Array<Notice & { seq: number; runtimeId?: string; invocationId?: string }>;
  invocationSummaries: InvocationSummaryState[];
  lastSeq: number;
}

export function emptyHarnessState(): HarnessState {
  return {
    runState: "idle",
    activeInvocations: new Map(),
    stopReasons: new Map(),
    timeline: [],
    messages: new Map(),
    harnessInputs: new Map(),
    toolCalls: new Map(),
    plans: new Map(),
    proposedPlans: new Map(),
    tasks: new Map(),
    approvals: new Map(),
    inputResponses: new Map(),
    approvalReviews: new Map(),
    harnessInvocations: new Map(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      hasEstimated: false,
    },
    perTarget: new Map(),
    perContextTarget: new Map(),
    errors: new Map(),
    notices: [],
    invocationSummaries: [],
    lastSeq: 0,
  };
}

function roleOfKind(kind: string): MessageRole {
  if (kind.startsWith("user_")) return "user";
  if (kind.startsWith("agent_thought")) return "thought";
  return "agent";
}

function getOrCreateMessage(
  state: HarnessState,
  id: string,
  role: MessageRole,
  createdAt: string,
  turnId?: string,
  harness?: string,
  harnessName?: string,
  runtimeId?: string,
  source?: EventSource,
  place = true,
): MessageState | undefined {
  const known = getMessage(state, id);
  if (known && !(
    known.kind === "input" && role === "user" ||
    known.kind === "output" && known.role === role
  )) return undefined;
  let msg = state.messages.get(id);
  if (!msg) {
    const content: MessageState = role === "user"
      ? inputMessage(id, createdAt, state.harnessInputs.get(id)?.source ?? source, harnessName)
      : {
          kind: "output", messageId: id, role, content: [], createdAt,
          source: harnessName ? { kind: "harness", key: harnessName } : actorOf(source ?? { type: "aide" }),
          target: { ...HUMAN_ACTOR },
        };
    msg = {
      ...content,
      invocationId: turnId,
      harness,
      harnessName,
      runtimeId,
    };
    state.messages.set(id, msg);
    if (place) placeMessage(state, id);
  } else {
    if (!msg.harness) msg.harness = harness;
    if (!msg.harnessName) msg.harnessName = harnessName;
    if (!msg.runtimeId) msg.runtimeId = runtimeId;
  }
  return msg;
}

function getOrCreateToolCall(
  state: HarnessState,
  id: string,
  turnId?: string,
  harness?: string,
  harnessName?: string,
  runtimeId?: string,
): ToolCallState {
  let tc = state.toolCalls.get(id);
  if (!tc) {
    tc = {
      toolCallId: id,
      harness,
      harnessName,
      runtimeId,
      status: "pending",
      content: [],
      locations: [],
      invocationId: turnId,
    };
    state.toolCalls.set(id, tc);
    state.timeline.push({ type: "tool_call", id });
  } else if (!tc.harness) {
    tc.harness = harness;
  }
  if (!tc.harnessName) tc.harnessName = harnessName;
  if (!tc.runtimeId) tc.runtimeId = runtimeId;
  return tc;
}

function applyMessageUpsert(
  state: HarnessState,
  ev: EventEnvelope<"user_message" | "agent_message" | "agent_thought">,
  role: MessageRole,
): void {
  const p = ev.payload;
  const inputPatch = ev.kind === "user_message" ? (ev as EventEnvelope<"user_message">).payload : undefined;
  const input = inputPatch ? state.harnessInputs.get(p.messageId) : undefined;
  // Harness echoes need not repeat delivery metadata. The owned Input still
  // determines whether consumption has occurred; a body is not a receipt.
  const pendingSteer = inputPatch !== undefined &&
    (inputPatch.delivery ?? input?.delivery) === "steer" &&
    input !== undefined && input.deliveryOutcome !== "applied";
  const msg = getOrCreateMessage(
    state,
    p.messageId,
    role,
    ev.ts,
    pendingSteer ? undefined : ev.invocationId,
    ev.harness,
    eventTargetId(ev),
    ev.runtimeId,
    ev.source,
    !pendingSteer,
  );
  if (!msg) return;
  applyMessageReplies(state, msg, p.replyToMessageIds);
  if (ev.kind === "agent_message" && msg.kind === "output") {
    const phase = (ev as EventEnvelope<"agent_message">).payload.phase;
    if (phase !== undefined) msg.phase = phase;
  }
  // 三态：省略=不变；null/[]=清空；数组=整体替换
  // A managed Input already owns its original body. Harness echoes may contain
  // transport Context or repeat that body; they only confirm execution here.
  const inputEcho = role === "user" && state.harnessInputs.has(p.messageId) && ev.source.type === "harness";
  if (p.content !== undefined && !inputEcho) {
    msg.content = p.content === null ? [] : [...p.content];
  }
  // EventEnvelope<union> 不随 kind 自动收窄（非判别联合入参），手动断言 user_message
  if (ev.kind === "user_message" && msg.kind === "input") {
    const userMessage = (ev as EventEnvelope<"user_message">).payload;
    if (!pendingSteer && msg.invocationId === undefined) msg.invocationId = ev.invocationId;
    const delivery = userMessage.delivery ?? input?.delivery;
    if (delivery !== undefined) msg.delivery = delivery;
    if (delivery === "follow_up" && msg.invocationId !== ev.invocationId) {
      // Esc may reclaim an unapplied native steer without changing messageId.
      // Its eventual prompt belongs to the new Turn and should appear after the
      // interrupted Turn, not at the hidden pending steer's original position.
      msg.invocationId = ev.invocationId;
      msg.harness = ev.harness;
      msg.harnessName = eventTargetId(ev);
      msg.runtimeId = ev.runtimeId;
      const timelineIndex = state.timeline.findIndex(
        (item) => item.type === "message" && item.id === msg.messageId,
      );
      if (timelineIndex >= 0) {
        const [item] = state.timeline.splice(timelineIndex, 1);
        if (item) state.timeline.push(item);
      }
    }
    if (!pendingSteer) placeMessage(state, msg.messageId);
    if (msg.consumedAt !== undefined) refreshConsumedSummary(state, msg.invocationId, ev.seq);
  }
  if (msg.kind === "output") msg.streamStatus = "completed";
}

function applyMessageChunk(
  state: HarnessState,
  ev: EventEnvelope<"user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk">,
  role: MessageRole,
): void {
  const p = ev.payload;
  const input = role === "user" ? state.harnessInputs.get(p.messageId) : undefined;
  const pendingSteer = input && input.delivery !== "prompt" && input.deliveryOutcome !== "applied";
  const msg = getOrCreateMessage(
    state,
    p.messageId,
    role,
    ev.ts,
    pendingSteer ? undefined : ev.invocationId,
    ev.harness,
    eventTargetId(ev),
    ev.runtimeId,
    ev.source,
    !pendingSteer,
  );
  if (!msg) return;
  if (pendingSteer && msg.kind === "input") msg.delivery = "steer";
  if (!input || ev.source.type !== "harness") msg.content.push(p.content);
  applyMessageReplies(state, msg, p.replyToMessageIds);
  if (msg.kind === "output") msg.streamStatus = "in_progress";
  else {
    if (!pendingSteer) {
      msg.invocationId ??= ev.invocationId;
      placeMessage(state, msg.messageId);
    }
    if (msg.consumedAt !== undefined) refreshConsumedSummary(state, msg.invocationId, ev.seq);
  }
}

/** @spec Queue admission seeds Input content once; lifecycle snapshots never overwrite an existing Message. */
function applyHarnessInputUpdate(
  state: HarnessState,
  ev: EventEnvelope<"harness_input.updated">,
): void {
  const p = ev.payload;
  const status = p.status;
  // Queue admission creates the same addressable Input, without granting it a
  // Transcript position or an executed Turn. Later receipts only add facts.
  const known = getMessage(state, p.messageId);
  const message = getOrCreateMessage(state, p.messageId, "user", ev.ts, undefined, ev.harness,
    p.harnessName, p.runtimeId, p.source, false);
  if (!message) return;
  // Queue transitions update execution state, never rewrite an existing Message.
  if (!known) message.content = [...p.blocks];
  const existing = state.harnessInputs.get(p.messageId);
  if (existing) {
    existing.status = status;
    existing.invocationId = p.invocationId;
    existing.delivery = p.delivery;
    if (p.blocks.length > 0) existing.blocks = [...p.blocks];
    return;
  }
  const deliveryState = message.kind === "input" ? message.deliveryState : undefined;
  state.harnessInputs.set(p.messageId, {
    messageId: p.messageId,
    invocationId: p.invocationId,
    harnessName: p.harnessName,
    runtimeId: p.runtimeId,
    ...(ev.harness === undefined ? {} : { harness: ev.harness }),
    status,
    delivery: p.delivery,
    blocks: [...p.blocks],
    source: p.source,
    ...(deliveryState !== undefined && deliveryState !== "pending"
      ? { deliveryOutcome: deliveryState }
      : {}),
    ...(p.harnessInvocationId === undefined
      ? {}
      : { harnessInvocationId: p.harnessInvocationId }),
  });
}

function applyToolCallUpdate(state: HarnessState, ev: EventEnvelope<"tool_call_update">): void {
  const p = ev.payload;
  const tc = getOrCreateToolCall(
    state,
    p.toolCallId,
    ev.invocationId,
    ev.harness,
    eventTargetId(ev),
    ev.runtimeId,
  );
  if (p.title !== undefined) tc.title = p.title === null ? undefined : p.title;
  if (p.kind !== undefined) tc.kind = p.kind === null ? undefined : p.kind;
  if (p.effect !== undefined) tc.effect = p.effect === null ? undefined : p.effect;
  if (p.status !== undefined && p.status !== null) tc.status = p.status;
  if (p.content !== undefined) tc.content = p.content === null ? [] : [...p.content];
  if (p.locations !== undefined) tc.locations = p.locations === null ? [] : [...p.locations];
  if (p.rawInput !== undefined) tc.rawInput = p.rawInput;
  if (p.rawOutput !== undefined) tc.rawOutput = p.rawOutput;
}

/** 该 turn 是否还有未决 Approval——per-turn requires_action 的派生依据。 */
function hasPendingBlocking(state: HarnessState, turnId: string): boolean {
  for (const approval of state.approvals.values()) {
    if (approval.request.invocationId === turnId && approval.request.status === "pending") return true;
  }
  return false;
}

/**
 * 会话级 runState 派生（workflow：存在 pending Approval 时
 * projection 必须产出 requires_action）。requires_action 比 running 优先上浮——它意味着
 * "没有用户动作会话无法完整推进"；未归属 turn 的 setup Approval 也不能漏。
 */
function deriveRunState(state: HarnessState): SessionRunState {
  if ([...state.approvals.values()].some((approval) => approval.request.status === "pending")) return "requires_action";
  if (state.activeInvocations.size === 0) return "idle";
  return [...state.activeInvocations.values()].some((turn) => turn.state === "requires_action")
    ? "requires_action"
    : "running";
}

function removePlan(state: HarnessState, planId: string): void {
  state.plans.delete(planId);
  for (let index = state.timeline.length - 1; index >= 0; index--) {
    const entry = state.timeline[index];
    if (entry?.type === "plan" && entry.id === planId) state.timeline.splice(index, 1);
  }
  for (const scope of [...state.perTarget.values(), ...state.perContextTarget.values()]) {
    if (scope.lastPlanId === planId) scope.lastPlanId = undefined;
  }
}

export function applyEvent(state: HarnessState, ev: AnyEventEnvelope): HarnessState {
  state.lastSeq = ev.seq;
  switch (ev.kind) {
    case "state_update": {
      const p = ev.payload;
      if (p.stopReason !== undefined) {
        state.lastStopReason = p.stopReason;
        if (ev.invocationId) state.stopReasons.set(ev.invocationId, p.stopReason);
      }
      if (p.state === "idle") {
        if (ev.invocationId) {
          // 只收本 turn 的口：并发 Turn 互不误清
          state.activeInvocations.delete(ev.invocationId);
        }
      } else if (ev.invocationId) {
        // 非 idle 态（running / requires_action）：turn 在场。startedAt
        // 以首个 running 为准，重复 running（reconnect 重放）不重置起点；
        // state 保真透传（requires_action ↔ running 可来回迁移），但 pending blocking
        // request 在场时钉在 requires_action——重放的 running 不得掩盖未决审批卡片。
        const existing = state.activeInvocations.get(ev.invocationId);
        if (!existing) {
          // 新 turn 首见即作废旧 plan 的 pin：未完成条目永存是常态（任务中断/未逐条
          // TaskUpdate），不清会让上一段工作的 plan 在每个后续 turn 里借尸还魂；
          // 本 turn 若真的更新 plan，plan_update 会重新 pin。
          for (const scope of executionScopes(state, ev)) scope.lastPlanId = undefined;
        }
        state.activeInvocations.set(ev.invocationId, {
          invocationId: ev.invocationId,
          harness: ev.harness ?? existing?.harness,
          harnessName: eventTargetId(ev) ?? existing?.harnessName,
          runtimeId: ev.runtimeId ?? existing?.runtimeId,
          state: hasPendingBlocking(state, ev.invocationId) ? "requires_action" : p.state,
          startedAt: existing?.startedAt ?? (ev.ts ? Date.parse(ev.ts) || undefined : undefined),
          phase: existing?.phase,
        });
      }
      break;
    }
    case "user_message":
    case "agent_message":
    case "agent_thought": {
      applyMessageUpsert(state, ev, roleOfKind(ev.kind));
      if (ev.kind === "user_message") {
        const request = [...state.harnessInvocations.values()].find(
          (candidate) => candidate.messageId === ev.payload.messageId,
        );
        if (request) request.phase = "running";
      }
      break;
    }
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      applyMessageChunk(state, ev, roleOfKind(ev.kind));
      break;
    case "tool_call_update":
      applyToolCallUpdate(state, ev);
      break;
    case "harness_input.updated":
      applyHarnessInputUpdate(state, ev);
      break;
    case "input_delivery_update":
      applyInputDelivery(state, ev);
      break;
    case "tool_call_content_chunk": {
      const p = ev.payload;
      const tc = getOrCreateToolCall(
        state,
        p.toolCallId,
        ev.invocationId,
        ev.harness,
        eventTargetId(ev),
        ev.runtimeId,
      );
      tc.content.push(p.content);
      break;
    }
    case "plan_update": {
      const p = ev.payload;
      if (!state.plans.has(p.planId)) state.timeline.push({ type: "plan", id: p.planId });
      const existing = state.plans.get(p.planId);
      const harness = ev.harness ?? existing?.harness;
      state.plans.set(p.planId, {
        planId: p.planId,
        entries: [...p.entries],
        invocationId: ev.invocationId ?? existing?.invocationId,
        harness,
        harnessName: eventTargetId(ev) ?? existing?.harnessName,
        runtimeId: ev.runtimeId ?? existing?.runtimeId,
      });
      for (const scope of executionScopes(state, ev)) scope.lastPlanId = p.planId;
      break;
    }
    case "plan_remove":
      removePlan(state, ev.payload.planId);
      break;
    case "proposed_plan": {
      const p = ev.payload;
      // 提案是完成态产物，不做原地更新；重复事件不能改写用户已经看到的内容。
      if (state.proposedPlans.has(p.planId)) break;
      state.timeline.push({ type: "proposed_plan", id: p.planId });
      state.proposedPlans.set(p.planId, {
        ...p,
        harness: ev.harness,
        harnessName: eventTargetId(ev),
        runtimeId: ev.runtimeId,
        invocationId: ev.invocationId,
      });
      break;
    }
    case "proposed_plan_implementation_started": {
      const proposal = state.proposedPlans.get(ev.payload.planId);
      if (!proposal || proposal.implementationTurnId) break;
      proposal.implementationTurnId = ev.payload.implementationTurnId;
      proposal.implementationStartedAt = ev.ts;
      break;
    }
    case "task_update": {
      const p = ev.payload;
      const harnessName = eventTargetId(ev);
      const taskKey = harnessTaskKey({
        taskId: p.taskId,
        runtimeId: ev.runtimeId,
        harnessName,
        harnessSessionId: ev.harnessSessionId,
      });
      const existing = state.tasks.get(taskKey);
      if (!existing && !p.skipTranscript) {
        state.timeline.push({ type: "task", id: taskKey });
      }
      // Only defined fields update a task; partial native events must preserve existing evidence.
      const next = { ...existing } as HarnessTaskState;
      for (const [key, value] of Object.entries(p)) {
        if (value !== undefined) {
          (next as unknown as Record<string, unknown>)[key] = value;
        }
      }
      if (!existing) {
        const startedAt = Date.parse(ev.ts);
        if (!Number.isNaN(startedAt)) next.startedAt = startedAt;
      }
      next.taskKey = taskKey;
      next.harness = ev.harness ?? existing?.harness;
      next.harnessName = harnessName ?? existing?.harnessName;
      next.harnessSessionId = ev.harnessSessionId ?? existing?.harnessSessionId;
      next.runtimeId = ev.runtimeId ?? existing?.runtimeId;
      next.invocationId = ev.invocationId ?? existing?.invocationId;
      state.tasks.set(taskKey, next);
      break;
    }
    // Approval requested/answered/cancelled 驱动 per-turn requires_action ↔ running：不变量收在 reducer，
    // 不要求 adapter 自觉配对 state_update（事件流是唯一真相源；见 docs/kernel.md）。
    // 原生 state_update(requires_action) 仍然有效——覆盖登录、设备确认等没有结构化
    // Approval 的场景（workflow：反向不强制成立）。
    case "approval.requested": {
      const request = inputRequestMessage(ev);
      const existing = getMessage(state, request.messageId);
      // lifecycle 事实只认第一次：重复 request 不能重写 requester/payload，更不能复活已终结对象。
      if (existing) break;
      state.approvals.set(request.messageId, {
        request,
        requestedEventId: ev.eventId,
      });
      placeMessage(state, request.messageId);
      flagRequiresAction(state, ev.invocationId);
      break;
    }
    case "approval.answered": {
      const existing = state.approvals.get(ev.payload.replyToMessageIds[0]);
      // terminal 只收一次；迟到/重复 answer 不得改写已经交付给 requester 的结果。
      if (!existing || existing.request.status !== "pending") break;
      if (!canResolveRequest(existing.request, ev.payload.answer, ev.payload.source)) break;
      if (ev.payload.replyToMessageIds.length !== 1 ||
        ev.payload.target.kind !== existing.request.source.kind || ev.payload.target.key !== existing.request.source.key) break;
      const response = inputResponseMessage(ev);
      if (getMessage(state, response.messageId)) break;
      existing.request.status = "answered";
      existing.request.responseMessageId = response.messageId;
      state.inputResponses.set(response.messageId, response);
      placeMessage(state, response.messageId);
      unflagRequiresAction(state, existing.request.invocationId);
      break;
    }
    case "approval.cancelled": {
      const existing = state.approvals.get(ev.payload.messageId);
      if (!existing || !canResolveRequest(existing.request, { kind: "cancelled", reason: ev.payload.reason }, actorOf(ev.source))) break;
      existing.request.status = "cancelled";
      existing.request.cancellation = {
        reason: ev.payload.reason,
        ...(ev.payload.detail === undefined ? {} : { detail: ev.payload.detail }),
      };
      unflagRequiresAction(state, existing.request.invocationId);
      break;
    }
    case "approval_review_update": {
      // 一等回执：按自己的 reviewId 归档、首见即进 timeline（无 target 也留痕、多次决策各自成条）。
      // 纯留痕，不参与 requires_action 派生。
      const p = ev.payload;
      if (!state.approvalReviews.has(p.reviewId)) {
        state.timeline.push({ type: "approval_review", id: p.reviewId });
      }
      state.approvalReviews.set(p.reviewId, { ...p, invocationId: ev.invocationId });
      break;
    }
    case "usage_update":
      accumulateUsage(state.usage, ev.payload);
      break;
    case "available_commands_update": {
      for (const scope of executionScopes(state, ev)) {
        scope.availableCommands = [...ev.payload.commands];
      }
      break;
    }
    case "config_option_update": {
      for (const scope of executionScopes(state, ev)) {
        scope.configOptions = [...ev.payload.options];
      }
      break;
    }
    case "context_window_update": {
      for (const scope of executionScopes(state, ev)) {
        scope.contextWindow = { ...ev.payload };
      }
      break;
    }
    case "_aide_delivery_attempt_update": {
      const update = ev.payload;
      const request =
        update.phase === "prepared"
          ? [...state.harnessInvocations.values()].find(
              (candidate) => candidate.messageId === update.inputId,
            )
          : [...state.harnessInvocations.values()].find(
              (candidate) => candidate.attemptId === update.attemptId,
            );
      if (!request) break;
      request.attemptId = update.attemptId;
      if (update.phase === "uncertain") request.phase = "uncertain";
      else if (request.phase === "uncertain" && update.phase !== "finalized") {
        request.phase = "running";
      }
      break;
    }
    case "_aide_harness_invocation_recorded": {
      if (state.harnessInvocations.has(ev.payload.invocationId)) break;
      state.harnessInvocations.set(ev.payload.invocationId, {
        invocationId: ev.payload.invocationId,
        verb: ev.payload.verb,
        title: ev.payload.title,
        pluginInstanceId:
          ev.source.type === "plugin" ? ev.source.pluginInstanceId : undefined,
        phase: "queued",
        runtimeId: ev.payload.runtimeId,
        harnessName: ev.payload.harnessName,
      });
      state.timeline.push({
        type: "harness_invocation",
        id: ev.payload.invocationId,
      });
      break;
    }
    case "_aide_harness_invocation_scheduled": {
      const request = state.harnessInvocations.get(ev.payload.invocationId);
      if (!request) break;
      request.phase = "queued";
      request.harnessName = ev.payload.harnessName;
      request.runtimeId = ev.payload.runtimeId;
      request.messageId = ev.payload.messageId;
      request.invocationId = ev.payload.invocationId;
      break;
    }
    case "_aide_harness_invocation_cancelled": {
      const request = state.harnessInvocations.get(ev.payload.invocationId);
      if (
        request && request.phase !== "completed" && request.phase !== "failed"
      ) {
        request.phase = "cancelled";
        request.cancellation = { ...ev.payload };
      }
      break;
    }
    case "_aide_harness_invocation_failed": {
      const request = state.harnessInvocations.get(ev.payload.invocationId);
      if (
        request && request.phase !== "completed" && request.phase !== "cancelled"
      ) {
        request.phase = "failed";
        request.failure = { ...ev.payload };
      }
      break;
    }
    case "_aide_error_update": {
      const errorEntry = {
        ...ev.payload,
        seq: ev.seq,
        invocationId: ev.invocationId,
        ...(ev.runtimeId ? { runtimeId: ev.runtimeId } : {}),
      };
      state.lastError = errorEntry;
      // 将错误加入 timeline 和 errors map
      const errorId = `err_${ev.seq}`;
      state.errors.set(errorId, errorEntry);
      state.timeline.push({ type: "error", id: errorId });
      break;
    }
    case "_aide_run_status": {
      const p = ev.payload;
      // per-turn 运行阶段；无 turnId 或未命中活跃 turn 时丢弃——phase 是短寿命
      // 短寿命装饰信息；turn 已收口后的迟到 phase 没有呈现意义。
      const turn = ev.invocationId ? state.activeInvocations.get(ev.invocationId) : undefined;
      if (turn) turn.phase = p.phase === null ? undefined : { phase: p.phase, title: p.title };
      break;
    }
    case "_aide_notice":
      state.notices.push({
        ...ev.payload,
        seq: ev.seq,
        invocationId: ev.invocationId,
        ...(ev.runtimeId ? { runtimeId: ev.runtimeId } : {}),
      });
      state.timeline.push({ type: "notice", id: `n_${ev.seq}` });
      break;
    case "_aide_invocation_summary": {
      const summary: InvocationSummaryState = {
        ...ev.payload,
        harness: ev.harness,
        harnessName: ev.harnessName,
        runtimeId: ev.runtimeId,
      };
      state.invocationSummaries.push(summary);
      const request = [...state.harnessInvocations.values()].find(
        (candidate) => candidate.invocationId === ev.payload.invocationId,
      );
      if (
        request && request.phase !== "cancelled" && request.phase !== "failed"
      ) {
        request.phase = "completed";
        request.result = summary;
      }
      break;
    }
    default: {
      // Events without a presentation projection do not change live state.
      break;
    }
  }
  // 派生值统一在出口重算（纯函数、代价 O(activeTurns)）：单点维护不变量，
  // 不用每个 case 记得更新
  state.runState = deriveRunState(state);
  return state;
}

/** HarnessConfiguration 是唯一状态实例坐标；缺省即无 Target 归属，绝不从 Harness 类型反推。 */
function eventTargetId(ev: Pick<AnyEventEnvelope, "harnessName">): string | undefined {
  return ev.harnessName;
}

/** 取或建 Target 状态槽；所有 Target-scoped 快照只经过这一处归属。 */
function targetScoped(
  state: HarnessState,
  ev: Pick<AnyEventEnvelope, "harnessName" | "harness">,
): HarnessConfigurationState | undefined {
  const targetId = eventTargetId(ev);
  if (!targetId) return undefined;
  let scoped = state.perTarget.get(targetId);
  if (!scoped) {
    scoped = {
      harness: ev.harness,
      availableCommands: [],
      configOptions: [],
    };
    state.perTarget.set(targetId, scoped);
  } else if (!scoped.harness && ev.harness) {
    scoped.harness = ev.harness;
  }
  return scoped;
}

export function contextTargetStateKey(runtimeId: string, harnessName: string): string {
  return `${runtimeId}\0${harnessName}`;
}

function laneTargetScoped(
  state: HarnessState,
  ev: Pick<AnyEventEnvelope, "harnessName" | "runtimeId" | "harness">,
): ContextTargetState | undefined {
  const runtimeId = ev.runtimeId;
  const targetId = ev.harnessName;
  if (!runtimeId || !targetId) return undefined;
  const key = contextTargetStateKey(runtimeId, targetId);
  let scoped = state.perContextTarget.get(key);
  if (!scoped) {
    scoped = {
      harness: ev.harness,
      availableCommands: [],
      configOptions: [],
    };
    state.perContextTarget.set(key, scoped);
  } else if (!scoped.harness && ev.harness) {
    scoped.harness = ev.harness;
  }
  return scoped;
}

function executionScopes(
  state: HarnessState,
  ev: Pick<AnyEventEnvelope, "harnessName" | "runtimeId" | "harness">,
): Array<HarnessConfigurationState | ContextTargetState> {
  return [targetScoped(state, ev), laneTargetScoped(state, ev)].filter(
    (scope): scope is HarnessConfigurationState | ContextTargetState => scope !== undefined,
  );
}

/** request 到场：所属 turn 派生为 requires_action（blocking request 挂起该 turn） */
function flagRequiresAction(state: HarnessState, turnId: string | undefined): void {
  const turn = turnId ? state.activeInvocations.get(turnId) : undefined;
  if (turn) turn.state = "requires_action";
}

/**
 * request 收口：仅当该 turn 已无其他 pending blocking request 时恢复 running——
 * 同 turn 并发多个审批时，应答一个不能提前撤掉 requires_action。
 */
function unflagRequiresAction(state: HarnessState, turnId: string | undefined): void {
  const turn = turnId ? state.activeInvocations.get(turnId) : undefined;
  if (turn && turn.state === "requires_action" && !hasPendingBlocking(state, turnId!)) {
    turn.state = "running";
  }
}

function accumulateUsage(total: UsageTotal, u: UsageUpdate): void {
  total.inputTokens += u.inputTokens ?? 0;
  total.outputTokens += u.outputTokens ?? 0;
  total.cacheReadTokens += u.cacheReadTokens ?? 0;
  total.cacheWriteTokens += u.cacheWriteTokens ?? 0;
  total.reasoningTokens += u.reasoningTokens ?? 0;
  if (u.isEstimated) total.hasEstimated = true;
}

export function reduceEvents(events: Iterable<AnyEventEnvelope>): HarnessState {
  const state = emptyHarnessState();
  for (const ev of events) applyEvent(state, ev);
  return state;
}
