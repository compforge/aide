import {
  type Harness,
  type ApprovalContext,
  type OpenApproval,
  type NativeEventSink,
  type PromptInput,
} from "../harness/adapter.ts";
import type { LogSink } from "../logging.ts";
import { logError } from "../logging.ts";
import {
  type AnyEventDraft,
  type AnyEventEnvelope,
  type AnyNewEvent,
  type EventEnvelope,
  type EventSource,
  type PromptBlock,
  type StopReason,
} from "../event/index.ts";
import type { LiveHarness } from "./hook.ts";
import type { ExecutionScope } from "../../protocol/verbs.ts";
import type { AgentStatus } from "@compforge/aide-plugin";
import { randomUUID } from "node:crypto";
import { createHarnessLaunchSnapshot } from "../harness/configuration.ts";
import { isSessionConfigurable, isModelConfigurable, isEffortConfigurable, isModelReadable } from "../harness/adapter.ts";
import type { HarnessConfiguration } from "../harness/configuration.ts";
import type {
  ApprovalDraft,
  ApprovalResult,
} from "../approval/types.ts";
import type { HarnessActivity } from "../harness/activity.ts";
import { DeliveryAttempts } from "./attempt.ts";
import {
  harnessInputUpdate,
  harnessInputSnapshot,
  type HarnessInputSource,
  type HarnessInputSnapshot,
} from "../harness/input.ts";
import {
  InvocationQueue,
  type QueueItem,
  type QueueRun,
  type QueueOutcome,
} from "../queue.ts";
import { HarnessApprovalContinuations } from "../approval/harness.ts";
import {
  HarnessHookCoordinator,
  type HarnessHookGateway,
} from "./hook.ts";

export type { HarnessHookGateway } from "./hook.ts";

export type {
  HarnessInputSource,
  HarnessInputSnapshot,
  HarnessInputStatus,
} from "../harness/input.ts";
export type {
  QueueSnapshot,
  QueueOutcome,
} from "../queue.ts";

export interface HarnessInvocationInput {
  readonly pluginInstanceId: string;
  readonly harnessName: string;
  readonly runtimeId: string;
  readonly source: HarnessInputSource;
  readonly messageId: string;
  readonly invocationId: string;
  readonly blocks: PromptBlock[];
}

export type HarnessInvocationCancellation = "queued" | "running";

function eventSourceOf(source: HarnessInputSource): EventSource {
  return source.type === "user"
    ? { type: "user" }
    : {
        type: "plugin",
        pluginInstanceId: source.pluginInstanceId,
      };
}

/** Controller 注入给 Adapter 的 Core ports；原生 Harness verb 只能经这些边界 lowering。 */
export interface HarnessAdapterPorts {
  /** Host-owned call scope for application tool composition; never inferred from configuration names. */
  scope: ExecutionScope;
  runtimeId: string;
  openApproval: OpenApproval;
  log: LogSink;
  nativeEvent: NativeEventSink;
}

export interface InvocationExecutorOptions {
  records: HarnessActivity;
  /** 目标尚未选择 model 时使用的 HarnessConfiguration 级持久偏好。 */
  modelPreferences?: Readonly<Record<string, string>>;
  /** 目标尚未选择 effort 时使用的 HarnessConfiguration 级持久偏好。 */
  effortPreferences?: Readonly<Record<string, string>>;
  /** 工厂按 target.harness 选择 Adapter，并可使用 target.id lowering 实例级配置。 */
  createAdapter(target: HarnessConfiguration, handlers: HarnessAdapterPorts): Harness;
  /** Optional Plugin notification surface for Harness send and event intake boundaries. */
  hooks?: HarnessHookGateway;
  /** HarnessConfiguration identity 的唯一 owner；未知 id 必须返回 undefined，不能反推 Harness。 */
  resolveHarness(harnessName: string): (HarnessConfiguration & { model?: string; effort?: string }) | undefined;
  onChange?: () => void;
  /**
   * cancel 后等待 harness 确认终态的宽限期。到期仍无终态则合成 terminal error 并
   * 推进队列（workflow：除 cancel grace 与 transport close 外不设全局 watchdog，
   * 合法的长任务不应被误杀）。
   */
  cancelGraceMs?: number;
  /** Maximum concurrently running resource contexts. */
  maxConcurrency?: number;
}

const DEFAULT_CANCEL_GRACE_MS = 10_000;
const DEFAULT_EXECUTION_CONCURRENCY = 4;

/** 打断标记文案：cancelled 终态时落一条 notice，执行时间线显示取消原因 */
export const INTERRUPTED_NOTICE_TITLE = "Conversation interrupted — tell the agent what to do differently";

/** @spec Execute admitted calls serially per live native session, with bounded concurrency across sessions.
 * @why Operators own business scheduling; this executor protects live handles and records transient call facts.
 * @link docs/kernel.md
 */
export class InvocationExecutor {
  /** Ephemeral native runtimes; recovery parameters always come from the caller. */
  private readonly runtimes = new Map<string, LiveHarness>();
  /** Serializes accepted prompt calls on one live runtime; never a business Input inbox. */
  private readonly queues = new Map<string, InvocationQueue<LiveHarness>>();
  private readonly deliveryAttempts: DeliveryAttempts<LiveHarness>;
  private readonly harnessApprovals: HarnessApprovalContinuations<LiveHarness>;
  private readonly unsubscribeApprovals: () => void;
  private readonly harnessHooks: HarnessHookCoordinator;
  private lifecycleState: "open" | "closing" | "closed" = "open";
  private closePromise?: Promise<void>;
  private activeCount = 0;
  private readonly running = new Set<Promise<void>>();
  /** 已开始处理的 Queue item 从 Harness setup 起即对 UI 可见。 */
  private readonly processing = new Map<
    string,
    { target: HarnessConfiguration; startedAt: number }
  >();

  constructor(private readonly options: InvocationExecutorOptions) {
    const concurrency = options.maxConcurrency ?? DEFAULT_EXECUTION_CONCURRENCY;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    this.deliveryAttempts = new DeliveryAttempts(
      (binding, event) =>
        this.appendEvent(binding, event, {
          type: "aide",
        }) as EventEnvelope<"_aide_delivery_attempt_update">,
    );
    this.harnessApprovals = new HarnessApprovalContinuations(
      (binding, event, source) => this.appendEvent(binding, event, source),
      () => this.changed(),
      () => options.records.projection,
    );
    this.unsubscribeApprovals = options.records.subscribe((event) => {
      if (event.kind === "approval.answered" || event.kind === "approval.cancelled") {
        this.harnessApprovals.observe();
      }
    });
    this.harnessHooks = new HarnessHookCoordinator({
      gateway: options.hooks,
      append: (binding, event) =>
        this.appendEvent(binding, event, {
          type: "harness",
          harnessName: binding.target.id,
        }),
      log: (entry) => options.records.log(entry),
    });

  }

  /** Publish live input state before the queue transition. */
  private recordHarnessInputTransition(
    input: QueueItem,
    status: QueueItem["status"],
    update?: { invocationId?: string; delivery?: QueueItem["delivery"] },
  ): number {
    const payload = harnessInputUpdate(input, status, update);
    return this.options.records.appendEvent({
      kind: "harness_input.updated",
      source: eventSourceOf(input.source),
      ...(input.parentEventId === undefined ? {} : { parentEventId: input.parentEventId }),
      harness: input.target.harness,
      harnessName: input.target.id,
      runtimeId: input.runtimeId,
      invocationId: payload.invocationId,
      payload,
    }).seq;
  }

  /**
   * 用户完成一个未决 Approval。先把用户事实持久化，再唤醒 Harness；没有活跃 continuation
   * 时返回 false，UI 据此提示 stale，而不是把响应写进一个无人消费的内存通道。
   * @spec 取消审批只中断该审批绑定的执行；拒绝单次权限不取消执行，过期响应无副作用。
   * @link tests/execution-approval.test.ts
   */
  completeApproval(approvalId: string, result: ApprovalResult): boolean {
    const invocationId = this.harnessApprovals.invocationId(approvalId);
    if (!this.harnessApprovals.complete(approvalId, result)) return false;
    const run = invocationId ? this.runForInvocation(invocationId) : undefined;
    if (result.kind === "cancelled" && run?.status === "active") {
      this.options.records.log({
        level: "info", source: "aide", component: "controller.approval",
        harnessName: run.binding.target.id, invocationId: invocationId,
        message: "approval cancelled; interrupting associated execution",
      });
      void this.interruptRecord(run);
    }
    return true;
  }

  private openHarnessApproval(
    runtimeId: string,
    harnessName: string,
    draft: ApprovalDraft,
    context?: ApprovalContext,
  ): Promise<ApprovalResult> {
    const binding = this.runtimes.get(this.runtimeKey(runtimeId, harnessName));
    if (!binding) return Promise.reject(new Error(`unknown context binding for approval: ${runtimeId} × ${harnessName}`));
    const active = this.queueForRuntime(runtimeId).activeRun;
    const invocationId =
      context?.invocationId ?? active?.invocationId ?? binding.setupInvocationId;
    return this.harnessApprovals.open(binding, draft, invocationId, context);
  }

  private queueForRuntime(runtimeId: string): InvocationQueue<LiveHarness> {
    let queue = this.queues.get(runtimeId);
    if (!queue) {
      queue = new InvocationQueue<LiveHarness>(
        runtimeId,
        (input, status, update) =>
          this.recordHarnessInputTransition(input, status, update),
      );
      this.queues.set(runtimeId, queue);
    }
    return queue;
  }

  private runForInvocation(invocationId: string): QueueRun<LiveHarness> | undefined {
    for (const queue of this.queues.values()) {
      const run = queue.run(invocationId);
      if (run) return run;
    }
    return undefined;
  }

  private nextRunnableQueue(): InvocationQueue<LiveHarness> | undefined {
    return [...this.queues.values()]
      .filter(
        (queue) =>
          queue.head !== undefined &&
          !queue.activeRun &&
          !this.processing.has(queue.runtimeId),
      )
      .sort((left, right) => left.head!.enqueueSeq - right.head!.enqueueSeq)[0];
  }

  /**
   * 所有**在世** HarnessInput 的只读快照：waiting + running item +
   * 已接受的 steer。终态输入（finalized/recalled/interrupted）不驻内存——其历史在事件流里
   * （`user_message`），与 turn 台账瘦身同一取舍。投影 / 诊断据此看到每条输入的 messageId 与消费状态。
   */
  get harnessInputs(): HarnessInputSnapshot[] {
    const out: HarnessInputSnapshot[] = [];
    for (const queue of this.queues.values()) {
      for (const input of queue.queued) out.push(harnessInputSnapshot(input));
      for (const run of queue.runs()) {
        if (run.status !== "active") continue;
        if (run.input) out.push(harnessInputSnapshot(run.input));
      }
    }
    return out;
  }

  /** Materializes a scheduled HarnessInvocation in its explicit resource context. */
  async enqueueHarnessInvocation(input: HarnessInvocationInput): Promise<QueueOutcome> {
    this.assertOpen();
    if (
      this.harnessInputs.some(
        (candidate) => candidate.harnessInvocationId === input.invocationId,
      )
    ) {
      return Promise.reject(
        new Error(`HarnessInvocation already has a live Input: ${input.invocationId}`),
      );
    }
    const target = this.targetFor(input.harnessName);
    const runtimeId = input.runtimeId;
    const queue = this.queueForRuntime(runtimeId);
    const submission = queue.enqueue(target, input.blocks, {
      source: input.source,
      harnessInvocationId: input.invocationId,
      identity: {
        messageId: input.messageId,
        invocationId: input.invocationId,
      },
    });
    this.changed();
    this.drain();
    return submission.outcome;
  }

  /** @spec Steering targets an existing invocation; admission and application are distinct live facts. */
  private async appendInput(operation: "steer" | "followUp", invocationId: string, messageId: string, text: string): Promise<{ accepted: boolean; reason?: string }> {
    const run = this.runForInvocation(invocationId);
    if (!run || run.status !== "active" || !run.binding.ref) return { accepted: false, reason: "not_running" };
    const binding = run.binding;
    const send = binding.adapter[operation];
    if (!send) return { accepted: false, reason: `${operation}_unsupported` };
    const existing = this.options.records.projection.harnessInputs.get(messageId);
    if (existing) return { accepted: existing.deliveryOutcome !== "failed", reason: "already_admitted" };
    const input = { messageId, invocationId, runtimeId: binding.runtimeId, target: binding.target, blocks: [{ type: "text" as const, text }],
      source: run.input?.source ?? { type: "user" as const }, status: "dispatching" as const, delivery: operation };
    this.appendEvent(binding, { kind: "harness_input.updated", invocationId, payload: harnessInputUpdate(input, "dispatching") }, { type: "aide" });
    const prompt = { invocationId, messageId, blocks: input.blocks };
    try {
      const before = this.harnessHooks.beforeInput(this.harnessHooks.dispatch(binding, prompt, messageId, operation));
      if (before) await before;
      if (run.status !== "active") {
        this.appendEvent(binding, { kind: "input_delivery_update", invocationId, payload: { messageId, state: "failed" } }, { type: "aide" });
        return { accepted: false, reason: "invocation_ended" };
      }
      const receipt = await send.call(binding.adapter, binding.ref!, prompt);
      if (!receipt.accepted || receipt.effective !== operation) {
        this.appendEvent(binding, { kind: "input_delivery_update", invocationId, payload: { messageId, state: "failed" } }, { type: "aide" });
        return { accepted: false, reason: `${operation}_rejected` };
      }
      this.appendEvent(binding, { kind: "harness_input.updated", invocationId, payload: harnessInputUpdate(input, operation === "steer" ? "steering" : "following") }, { type: "aide" });
      this.appendEvent(binding, { kind: "user_message", invocationId, payload: { messageId, content: input.blocks, delivery: operation } }, eventSourceOf(input.source));
      if (operation === "steer" && binding.adapter.steering?.deliveryTracking === "ack-only") this.appendEvent(binding, { kind: "input_delivery_update", invocationId,
        payload: { messageId, state: "applied" } }, { type: "aide" });
      return { accepted: true };
    } catch (error) {
      this.appendEvent(binding, { kind: "input_delivery_update", invocationId, payload: { messageId, state: "failed", detail: String(error) } }, { type: "aide" });
      this.synthesizeTerminal(run, { message: String(error), stopReason: "error" });
      await this.closeHarness(binding).catch(() => {});
      throw error;
    }
  }

  /** Cancels a queued Request, or interrupts its active Queue run. */
  cancelHarnessInvocation(harnessInvocationId: string): HarnessInvocationCancellation | undefined {
    for (const queue of this.queues.values()) {
      if (queue.cancelHarnessInvocation(harnessInvocationId)) {
        this.changed();
        return "queued";
      }
      for (const active of queue.runs()) {
        if (
          active.status === "active" &&
          active.input?.harnessInvocationId === harnessInvocationId
        ) {
          void this.interruptRecord(active);
          return "running";
        }
      }
    }
    return undefined;
  }

  private async interruptRecord(active: QueueRun<LiveHarness>): Promise<void> {
    if (!active.binding.ref) {
      // preparing：Esc 立即生效，不被冷启动绑住。启动流程继续完成——成功则 binding
      // 保留给后续 turn 复用；卡死由 adapter 的启动期超时兜底，不会永久占住队列。
      this.synthesizeTerminal(active, { stopReason: "cancelled" });
      return;
    }
    active.cancelGraceTimer ??= setTimeout(() => {
      this.synthesizeTerminal(active, {
        message: "cancel grace period expired without harness confirmation",
        stopReason: "cancelled",
      });
    }, this.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
    try {
      await active.binding.adapter.abort(active.binding.ref);
    } catch (error) {
      this.options.records.log({
        level: "error",
        source: "aide",
        component: "controller.cancel",
        harness: active.binding.adapter.harness,
        harnessName: active.binding.target.id,
        invocationId: active.invocationId,
        message: "harness cancel request failed",
        error: logError(error),
      });
      // cancel 请求本身失败（transport 已断等）：不再等 harness，直接合成终态
      this.synthesizeTerminal(active, {
        message: `cancel request failed: ${error instanceof Error ? error.message : String(error)}`,
        stopReason: "cancelled",
      });
    }
  }

  /** Release only an idle context. Native state is already owned by its Harness. */
  async releaseRuntime(runtimeId: string): Promise<boolean> {
    const queue = this.queues.get(runtimeId);
    if (this.processing.has(runtimeId) || queue?.head || queue?.activeRun) return false;
    const bindings = [...this.runtimes.entries()].filter(([, binding]) => binding.runtimeId === runtimeId);
    for (const [key] of bindings) this.runtimes.delete(key);
    this.queues.delete(runtimeId);
    for (const [, binding] of bindings) {
      try { await this.closeHarness(binding); }
      catch (error) { this.options.records.log({ level: "warn", source: "aide", component: "controller.release",
        message: "Idle native session close failed", harnessName: binding.target.id, error: logError(error) }); }
    }
    return true;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifecycleState = "closing";
    this.closePromise = this.closeActive();
    return this.closePromise;
  }

  private async closeActive(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const binding of this.runtimes.values()) {
      closing.push(
        this.closeHarness(binding).catch((error) => {
          this.options.records.log({
            level: "warn",
            source: "aide",
            component: "controller.close",
            harness: binding.adapter.harness,
            harnessName: binding.target.id,
            message: "harness close failed",
            error: logError(error),
          });
        }),
      );
    }
    await Promise.all(closing);
    // Adapter.close owns native resource teardown, while Controller owns the
    // accepted-invocation invariant. A buggy/failed Adapter close must not leave a
    // Queue run or native approval continuation hanging during host shutdown.
    for (const turn of [...this.queues.values()].flatMap(queue => [...queue.runs()])) {
      if (turn.status === "active") {
        this.synthesizeTerminal(turn, { stopReason: "cancelled" });
      }
    }
    await Promise.allSettled([
      ...this.running,
    ]);
    await this.harnessHooks.close();
    this.unsubscribeApprovals();
    this.lifecycleState = "closed";
  }

  private drain(): void {
    if (this.lifecycleState !== "open") return;
    const concurrency = this.options.maxConcurrency ?? DEFAULT_EXECUTION_CONCURRENCY;
    while (this.lifecycleState === "open" && this.activeCount < concurrency) {
      const queue = this.nextRunnableQueue();
      const input = queue?.dequeue();
      if (!input) return;
      this.activeCount++;
      this.changed();
      const running = this.runQueueItem(input)
        .then(() => input.resolve?.("completed"), (error) => input.reject?.(error))
        .finally(() => {
          this.running.delete(running);
          this.activeCount--;
          this.changed();
          this.drain();
        });
      this.running.add(running);
      void running;
    }
  }

  private assertOpen(): void {
    if (this.lifecycleState !== "open") {
      throw new Error(`Controller is ${this.lifecycleState}`);
    }
  }

  /** Record the prompt and running fact before opening the native binding. */
  private startInvocation(
    binding: LiveHarness,
    opts: { invocationId: string; input?: QueueItem; harnessSessionId?: string },
  ): { record: QueueRun<LiveHarness>; run: QueueRun<LiveHarness>; settled: Promise<void> } {
    let inputEventId: string | undefined;
    if (opts.input) {
      const inputEvent = this.appendEvent(
        binding,
        {
          kind: "user_message",
          ...(opts.input.parentEventId === undefined
            ? {}
            : { parentEventId: opts.input.parentEventId }),
          harnessSessionId: opts.harnessSessionId,
          invocationId: opts.invocationId,
          payload: {
            messageId: opts.input.messageId,
            content: opts.input.blocks,
          },
        },
        eventSourceOf(opts.input.source),
      );
      inputEventId = inputEvent.eventId;
    }
    this.appendEvent(
      binding,
      {
        kind: "state_update",
        harnessSessionId: opts.harnessSessionId,
        invocationId: opts.invocationId,
        payload: { state: "running" },
      },
      { type: "aide" },
    );
    const queue = this.queueForRuntime(binding.runtimeId);
    const { run, settled } = queue.startRun(binding, opts.invocationId, opts.input);
    run.inputEventId = inputEventId;
    return { record: run, run, settled };
  }

  private async runQueueItem(input: QueueItem): Promise<void> {
    this.processing.set(input.runtimeId, {
      target: input.target,
      startedAt: Date.now(),
    });

    // Publish the input before cold startup so live progress is visible during initialization.
    let binding: LiveHarness;
    let record: QueueRun<LiveHarness>;
    let run: QueueRun<LiveHarness>;
    let settled: Promise<void>;
    try {
      binding = this.runtimeFor(input.runtimeId, input.target.id, input.invocationId);
      ({ record, run, settled } = this.startInvocation(binding, {
        invocationId: input.invocationId,
        input,
        harnessSessionId: binding.sessionId,
      }));
    } catch (error) {
      this.processing.delete(input.runtimeId);
      this.changed();
      throw error;
    }
    const targetKey = binding.target.id;
    const coldStart = !binding.ref;
    if (coldStart) {
      // 冷启动阶段对用户可见（否则 spinner 只能显示误导性的 thinking…）；
      // idle 终态会连带清掉 phase，失败/取消路径无需单独收尾
      this.appendEvent(
        binding,
        {
          kind: "_aide_run_status",
          invocationId: input.invocationId,
          payload: { phase: "starting", title: `Starting ${input.target.harness}…` },
        },
        { type: "aide" },
      );
    }

    try {
      await this.ensureHarness(input.runtimeId, input.target.id);
      // A cold open can finish after close() has frozen scheduling. The Binding
      // has already released that late handle; close the accepted Aide invocation as
      // cancelled and leave later queued Inputs durable for the next resume.
      if (this.lifecycleState !== "open") {
        this.synthesizeTerminal(record, { stopReason: "cancelled" });
        return;
      }
      // preparing 期间被取消：终态已合成、summary 已落，不再向 harness 提交
      if (record.status === "finalized") return;
      if (!binding.ref) throw new Error(`${targetKey} failed to start`);
      if (coldStart) {
        this.appendEvent(
          binding,
          {
            kind: "_aide_run_status",
            invocationId: input.invocationId,
            payload: { phase: null },
          },
          { type: "aide" },
        );
      }

      if (!binding.launchSnapshot) {
        throw new Error(
          `cannot prepare harness delivery for invocation ${record.invocationId}: missing HarnessLaunchSnapshot`,
        );
      }
      const attempt = this.deliveryAttempts.prepare(binding, {
        invocationId: record.invocationId,
        inputEventId: run.inputEventId,
        inputId: input.messageId,
        launchSnapshot: binding.launchSnapshot,
        harnessSessionId: binding.sessionId,
      });
      const promptInput: PromptInput = {
        invocationId: input.invocationId,
        messageId: input.messageId,
        blocks: input.blocks,
      };
      const beforeInput = this.harnessHooks.beforeInput(
        this.harnessHooks.dispatch(
          binding,
          promptInput,
          attempt.attemptId,
          "new_turn",
        ),
      );
      if (beforeInput) await beforeInput;
      this.deliveryAttempts.markDispatching(binding, attempt);

      // sendTurn 回执只确认 Adapter 接受本次投递责任；Harness 终态仍由 idle Event 收口。
      // Adapter 契约规定：throw 只发生在接受责任之前；接受后即使原生 transport 失败，
      // 也必须经事件流报告终态，不能把不确定性藏进一个迟到 rejection。
      try {
        const receipt = await this.harnessHooks.send(
          binding,
          binding.ref,
          promptInput,
          attempt.attemptId,
          "new_turn",
          false,
        );
        if (receipt.effective !== "new_turn") {
          const reason =
            receipt.effective === "rejected" && receipt.reason
              ? `: ${receipt.reason}`
              : "";
          throw new Error(
            `adapter ${binding.adapter.harness} rejected Aide invocation ${input.invocationId}${reason}`,
          );
        }
      } catch (error) {
        this.deliveryAttempts.finalize(binding, attempt, "not_accepted", {
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      this.deliveryAttempts.markAccepted(binding, attempt);
      await settled;
    } catch (error) {
      // Invocation cancellation does not make a failed native runtime reusable.
      const detail = error instanceof Error ? error.message : String(error);
      this.options.records.log({
        level: "error",
        source: "aide",
        component: "controller.turn",
        harness: input.target.harness,
        harnessName: targetKey,
        invocationId: input.invocationId,
        message: "Harness invocation or native binding failed",
        error: logError(error),
      });
      // Close the live execution on startup/admission failure, then report failure to the caller.
      this.synthesizeTerminal(run, { message: detail, stopReason: "error" });
      // A failed native runtime must not poison later explicit resume attempts.
      this.runtimes.delete(this.runtimeKey(input.runtimeId, input.target.id));
      await this.closeHarness(binding).catch(() => {});
      if (record.status === "finalized" && this.options.records.projection.stopReasons.get(input.invocationId) === "cancelled") return;
      throw new Error(`Harness ${targetKey}: ${detail}`, {
        cause: error,
      });
    } finally {
      this.processing.delete(input.runtimeId);
      this.deliveryAttempts.release(input.invocationId);
      this.changed();
    }
  }

  /** Deliver live events to the current execution and UI; never persist or replay them. */
  private appendEvent(
    binding: LiveHarness,
    ev: AnyEventDraft,
    source: EventSource,
  ): AnyEventEnvelope {
    const envelope = this.options.records.appendEvent({
      ...ev,
      source,
      harness: binding.adapter.harness,
      harnessName: binding.target.id,
      runtimeId: binding.runtimeId,
    } as AnyNewEvent) as AnyEventEnvelope;
    if (envelope.kind === "state_update") {
      const p = envelope.payload;
      if (p.state === "idle") {
        // 终态一律按 invocationId 查表路由（不看 binding）。缺少 ID 的终态：
        // 无法归属任何调用，不驱动生命周期（adapter 契约要求
        // 终态必带 invocationId，由契约测试钉住）。
        if (envelope.invocationId) {
          // Attempt 对账先于 Invocation 幂等收口：cancel grace 后迟到的 Harness idle 虽然不能
          // 二次 finalize Invocation，却仍是把 uncertain Attempt 收敛到终态的权威 Receipt。
          this.deliveryAttempts.observeTerminal(binding, envelope);
          this.finalize(envelope);
        }
      }
    }
    // Projection 已在 HarnessActivity 内同步 reduce；终态对 Controller 私有台账的
    // 变更仍由 finalize 自己通知。
    return envelope;
  }

  /**
   * @spec A durable terminal closes only its admitted invocation: approvals, summary, then queue release.
   * @why Duplicate or late native terminals cannot close a newer invocation reusing the same context.
   * @link tests/execution-approval.test.ts
   */
  private finalize(terminal: EventEnvelope<"state_update">): void {
    const invocationId = terminal.invocationId;
    if (!invocationId) return;
    const stopReason = terminal.payload.stopReason;
    const run = this.runForInvocation(invocationId);
    if (!run || run.status === "finalized") return;
    const record = run;

    // cancel-cascade：本 turn 仍挂起的 Approval 随收口一并了结，绝不留悬挂 continuation。
    // Controller 先持久化 approval.cancelled，再唤醒 Adapter；参考 codex
    // clear_pending_waiters→Abort、opencode interrupt 的 ensuring(pending.delete)。
    // 顺序天然对：finalize 发生在 adapter.cancel 之后（先中断 turn，再收 pending），不会让取消以
    // model 可见的 tool rejection 抢在 turn 中断之前冒出来。
    this.harnessApprovals.cancelForInvocation(invocationId);

    const records = this.options.records;

    // 用户打断的 turn 在时间线留下醒目标记；排队的后续输入会自然跟在标记后面
    if (stopReason === "cancelled") {
      records.appendEvent({
        kind: "_aide_notice",
        source: { type: "aide" },
        harness: record.binding.adapter.harness,
        harnessName: record.binding.target.id,
        runtimeId: record.runtimeId,
        invocationId: invocationId,
        payload: { level: "warning", title: INTERRUPTED_NOTICE_TITLE },
      });
    }

    records.summarizeInvocationEvent(invocationId);

    this.queueForRuntime(run.runtimeId).finishRun(run, stopReason);

    this.changed();
  }

  /**
   * controller 合成终态：可选的结构化 error 留痕 + idle，走统一事件管线（→ finalize）。
   * 使用方：cancel 宽限期到期 / cancel 请求失败 / preparing 取消（无 error，纯 cancelled）/
   * 启动与投递失败（stopReason:"error"）。
   */
  private synthesizeTerminal(
    record: Pick<QueueRun<LiveHarness>, "binding" | "invocationId" | "status">,
    opts: { message?: string; stopReason: StopReason },
  ): void {
    if (record.status === "finalized") return;
    if (opts.message !== undefined) {
      this.appendEvent(
        record.binding,
        {
          kind: "_aide_error_update",
          invocationId: record.invocationId,
          payload: { message: opts.message, retryable: false },
        },
        { type: "aide" },
      );
    }
    this.appendEvent(
      record.binding,
      {
        kind: "state_update",
        invocationId: record.invocationId,
        payload: { state: "idle", stopReason: opts.stopReason },
      },
      { type: "aide" },
    );
  }

  /**
   * Establish call correlation before native startup, so startup approvals and progress have an owner.
   */
  private runtimeKey(runtimeId: string, harnessName: string): string {
    return `${runtimeId}\0${harnessName}`;
  }

  private runtimeFor(
    runtimeId: string,
    harnessName: string,
    setupInvocationId?: string,
  ): LiveHarness {
    const key = this.runtimeKey(runtimeId, harnessName);
    const binding = this.runtimes.get(key);
    if (!binding) throw new Error(`No prepared Harness call: ${runtimeId}`);
    if (setupInvocationId) binding.setupInvocationId = setupInvocationId;
    return binding;
  }

  /** Prepare an ephemeral runtime from explicit parameters. No resource fields are read or written. */
  prepare(harnessName: string, scope: ExecutionScope, sessionId?: AgentStatus["sessionId"]): LiveHarness {
    const previous = sessionId ? this.findRuntime(harnessName, scope, sessionId) : undefined;
    if (previous) return previous;
    const runtimeId = randomUUID();
    const key = this.runtimeKey(runtimeId, harnessName);
    const target = this.targetFor(harnessName);
    const adapter = this.options.createAdapter(target, {
        scope, runtimeId,
        openApproval: (approval, context) =>
          this.openHarnessApproval(runtimeId, target.id, approval, context),
        log: (entry) =>
          this.options.records.log({ ...entry, harnessName: target.id }),
        nativeEvent: (event) =>
          this.options.records.nativeEvent(
            target.id,
            target.harness,
            event,
            runtimeId,
          ),
      });
    const runtime = { runtimeId, target, adapter, scope, sessionId };
    this.runtimes.set(key, runtime);
    return runtime;
  }

  findRuntime(harnessName: string, scope: ExecutionScope, sessionId: string): LiveHarness | undefined {
    return [...this.runtimes.values()].find(runtime => runtime.target.id === harnessName && runtime.sessionId === sessionId
      && runtime.scope.pluginInstanceId === scope.pluginInstanceId && runtime.scope.resourceRef?.uid === scope.resourceRef?.uid);
  }

  /** Open the provider from caller-supplied parameters; references are returned, never persisted here. */
  private async ensureHarness(runtimeId: string, targetId: string): Promise<LiveHarness> {
    const context = this.runtimeFor(runtimeId, targetId);
    const existingOpen = this.opening.get(context);
    if (existingOpen) { await existingOpen; return context; }
    if (context.ref) return context;
    const records = this.options.records;
    const options = { cwd: records.cwd, sessionId: context.sessionId };
    const receive = (event: import("../harness/adapter.ts").HarnessEvent) => this.harnessHooks.acceptHarnessEvent(context, event);
    let publishedId: string | undefined;
    const reference = (value: import("../harness/adapter.ts").HarnessSessionReference) => {
      if (options.sessionId && value.identity.id !== options.sessionId) throw new Error("Harness resumed a different native session");
      if (publishedId && publishedId !== value.identity.id) throw new Error("Harness changed native session identity within a live runtime");
      publishedId = value.identity.id;
      context.sessionId = value.identity.id;
    };
    const opening = (async () => {
      context.ref = options.sessionId
        ? await context.adapter.resume({ ...options, sessionId: options.sessionId }, receive, reference)
        : await context.adapter.create(options, receive, reference);
      const configured = this.options.resolveHarness(targetId);
      let model = configured?.model ?? this.options.modelPreferences?.[targetId];
      const effort = configured?.effort ?? this.options.effortPreferences?.[targetId];
      if (model) {
        if (isSessionConfigurable(context.adapter)) await context.adapter.setConfig(context.ref, "model", model);
        else if (isModelConfigurable(context.adapter)) await context.adapter.setModel(context.ref, model);
      }
      if (effort) {
        if (isSessionConfigurable(context.adapter)) await context.adapter.setConfig(context.ref, "effort", effort);
        else if (isEffortConfigurable(context.adapter)) await context.adapter.setEffort(context.ref, effort);
      }
      if (isModelReadable(context.adapter)) model = context.adapter.currentModel(context.ref) ?? undefined;
      context.launchSnapshot = createHarnessLaunchSnapshot({ target: context.target, harnessSessionKey: context.adapter.harness, cwd: options.cwd, model, effort });
      records.log({ level: "info", source: "aide", component: "harness.session", harness: context.target.harness,
        harnessName: targetId, message: "Native session opened", attributes: { runtimeId, resourceUid: context.scope.resourceRef?.uid ?? null, sessionId: context.sessionId ?? null, resumed: context.ref.resumed ?? false } });
    })();
    this.opening.set(context, opening);
    try { await opening; return context; }
    finally { this.opening.delete(context); context.setupInvocationId = undefined; }
  }

  /** Session operations use the same provider boundary without creating an inference invocation. */
  async operate(runtimeId: string, targetId: string, input: import("@compforge/aide-plugin").HarnessOperationInput): Promise<import("@compforge/aide-plugin").HarnessOperationValue> {
    this.assertOpen();
    const key = this.runtimeKey(runtimeId, targetId);
    const current = this.runtimes.get(key);
    if (input.operation === "abort") {
      const run = this.runForInvocation(input.invocationId);
      if (run) await this.interruptRecord(run);
      return { outcome: "accepted" };
    }
    if (input.operation === "followUp" || input.operation === "steer") {
      const result = await this.appendInput(input.operation, input.invocationId, input.messageId, input.prompt);
      return { outcome: result.accepted ? "accepted" : "rejected", reason: result.reason };
    }
    if (this.processing.has(runtimeId) || this.queues.get(runtimeId)?.head || (current && this.opening.has(current))) return { outcome: "rejected", reason: "session_busy" };
    if (input.operation === "close") {
      if (current) await this.closeHarness(current);
      return { outcome: "accepted" };
    }
    const context = this.runtimeFor(runtimeId, targetId);
    try {
      await this.ensureHarness(runtimeId, targetId);
      if (!context.sessionId) {
        await this.closeHarness(context);
        return { outcome: "rejected", reason: "session_reference_unavailable" };
      }
      return { outcome: "accepted", ...(context.sessionId ? { sessionId: context.sessionId } : {}) };
    } catch (error) {
      await this.closeHarness(context).catch(() => {});
      throw error;
    }
  }

  private readonly opening = new Map<LiveHarness, Promise<void>>();
  private async closeHarness(context: LiveHarness): Promise<void> {
    const key = this.runtimeKey(context.runtimeId, context.target.id);
    if (this.runtimes.get(key) === context) this.runtimes.delete(key);
    await this.opening.get(context)?.catch(() => {});
    const ref = context.ref;
    context.ref = undefined;
    if (ref) await context.adapter.close(ref);
  }

  private targetFor(harnessName: string): HarnessConfiguration {
    const resolved = this.options.resolveHarness(harnessName);
    if (!resolved) {
      throw new Error(`HarnessConfiguration not registered: ${harnessName}`);
    }
    if (!resolved.id || resolved.id !== harnessName || !resolved.harness) {
      throw new Error(
        `invalid HarnessConfiguration for ${harnessName}: id=${resolved.id}, harness=${resolved.harness}`,
      );
    }
    return Object.freeze({ id: resolved.id, harness: resolved.harness });
  }

  private changed(): void {
    this.options.onChange?.();
  }
}
