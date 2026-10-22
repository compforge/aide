import {
  isContextSynchronizable,
  type HarnessAdapter,
  type ApprovalContext,
  type OpenApproval,
  type NativeEventSink,
  type PromptInput,
} from "../harness/adapter.ts";
import { buildTargetCatchUpContext } from "../context/mention.ts";
import {
  ContextDeliveries,
  executionHistorySource,
  type ContextDeliveryTransport,
  type ContextSnapshotEnvelope,
} from "../context/delivery.ts";
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
import { HarnessBinding } from "../harness/binding.ts";
import type { HarnessTarget } from "../harness/target.ts";
import type {
  ApprovalDraft,
  ApprovalResult,
} from "../approval/types.ts";
import type { HarnessStore } from "../harness/store.ts";
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
  readonly harnessTargetId: string;
  readonly contextId: string;
  readonly freshContext?: boolean;
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
  openApproval: OpenApproval;
  log: LogSink;
  nativeEvent: NativeEventSink;
}

export interface InvocationExecutorOptions {
  records: HarnessStore;
  mentionBudgetChars: number;
  /** 目标尚未选择 model 时使用的 HarnessTarget 级持久偏好。 */
  modelPreferences?: Readonly<Record<string, string>>;
  /** 目标尚未选择 effort 时使用的 HarnessTarget 级持久偏好。 */
  effortPreferences?: Readonly<Record<string, string>>;
  /** 工厂按 target.harness 选择 Adapter，并可使用 target.id lowering 实例级配置。 */
  createAdapter(target: HarnessTarget, handlers: HarnessAdapterPorts): HarnessAdapter;
  /** Optional Plugin notification surface for Harness send and ledger intake boundaries. */
  hooks?: HarnessHookGateway;
  /** HarnessTarget identity 的唯一 owner；未知 id 必须返回 undefined，不能反推 Harness。 */
  resolveTarget(harnessTargetId: string): HarnessTarget | undefined;
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

/** 打断标记文案：cancelled 终态时落一条 notice，TUI 时间线醒目提示（对齐 Codex 的体验） */
export const INTERRUPTED_NOTICE_TITLE = "Conversation interrupted — tell the agent what to do differently";

/** @spec Execute admitted Harness invocations, serial per resource context and concurrent across contexts.
 * @why Resource controllers own business scheduling; this executor only protects native bindings and records execution facts.
 * @link docs/kernel.md
 */
export class InvocationExecutor {
  /** Resource context × HarnessTarget → live binding. */
  private readonly bindings = new Map<string, HarnessBinding>();
  /** Every Queue is permanently bound to one resource context. */
  private readonly queues = new Map<string, InvocationQueue<HarnessBinding>>();
  private readonly deliveryAttempts: DeliveryAttempts<HarnessBinding>;
  private readonly contextDeliveries: ContextDeliveries<HarnessBinding>;
  private readonly harnessApprovals: HarnessApprovalContinuations<HarnessBinding>;
  private readonly unsubscribeApprovals: () => void;
  private readonly harnessHooks: HarnessHookCoordinator;
  private lifecycleState: "open" | "closing" | "closed" = "open";
  private closePromise?: Promise<void>;
  private activeCount = 0;
  private readonly running = new Set<Promise<void>>();
  /** 已开始处理的 Queue item 从 Harness setup 起即对 UI 可见。 */
  private readonly processing = new Map<
    string,
    { target: HarnessTarget; startedAt: number }
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
      options.records.ledger.read(),
    );
    this.contextDeliveries = new ContextDeliveries(
      (binding, event) => this.appendEvent(binding, event, { type: "aide" }),
      options.records.ledger.read(),
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
          harnessTargetId: binding.target.id,
        }),
      log: (entry) => options.records.log(entry),
    });

  }

  /** Event Ledger WAL entry written before the in-memory queue transition. */
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
      harnessTargetId: input.target.id,
      contextId: input.contextId,
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
        harnessTargetId: run.binding.target.id, invocationId: invocationId,
        message: "approval cancelled; interrupting associated execution",
      });
      void this.interruptRecord(run);
    }
    return true;
  }

  private openHarnessApproval(
    contextId: string,
    harnessTargetId: string,
    draft: ApprovalDraft,
    context?: ApprovalContext,
  ): Promise<ApprovalResult> {
    const binding = this.bindings.get(this.bindingKey(contextId, harnessTargetId));
    if (!binding) return Promise.reject(new Error(`unknown context binding for approval: ${contextId} × ${harnessTargetId}`));
    const active = this.queueForContext(contextId).activeRun;
    const invocationId =
      context?.invocationId ?? active?.invocationId ?? binding.setupInvocationId;
    return this.harnessApprovals.open(binding, draft, invocationId, context);
  }

  private queueForContext(contextId: string): InvocationQueue<HarnessBinding> {
    this.options.records.requireExecutionContext(contextId);
    let queue = this.queues.get(contextId);
    if (!queue) {
      queue = new InvocationQueue<HarnessBinding>(
        contextId,
        (input, status, update) =>
          this.recordHarnessInputTransition(input, status, update),
      );
      this.queues.set(contextId, queue);
    }
    return queue;
  }

  private runForInvocation(invocationId: string): QueueRun<HarnessBinding> | undefined {
    for (const queue of this.queues.values()) {
      const run = queue.run(invocationId);
      if (run) return run;
    }
    return undefined;
  }

  private nextRunnableQueue(): InvocationQueue<HarnessBinding> | undefined {
    return [...this.queues.values()]
      .filter(
        (queue) =>
          queue.head !== undefined &&
          !queue.activeRun &&
          !this.processing.has(queue.contextId),
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
    const target = this.targetFor(input.harnessTargetId);
    const contextId = this.options.records.requireExecutionContext(input.contextId).contextId;
    if (input.freshContext) {
      if (this.processing.has(contextId) || this.harnessInputs.some((item) => item.contextId === contextId)) throw new Error("Cannot replace an active context");
      const key = this.bindingKey(contextId, target.id);
      const binding = this.bindings.get(key);
      if (binding) await binding.close();
      this.bindings.delete(key);
      this.options.records.setContextHarnessSession(contextId, target.id, {
        harness: target.harness, contextAfterSeq: this.options.records.projection.lastSeq,
      });
    }
    const queue = this.queueForContext(contextId);
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

  private async interruptRecord(active: QueueRun<HarnessBinding>): Promise<void> {
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
      await active.binding.adapter.cancel(active.binding.ref);
    } catch (error) {
      this.options.records.log({
        level: "error",
        source: "aide",
        component: "controller.cancel",
        harness: active.binding.adapter.harness,
        harnessTargetId: active.binding.target.id,
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

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifecycleState = "closing";
    this.closePromise = this.closeActive();
    return this.closePromise;
  }

  private async closeActive(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const binding of this.bindings.values()) {
      closing.push(
        binding.close().catch((error) => {
          this.options.records.log({
            level: "warn",
            source: "aide",
            component: "controller.close",
            harness: binding.adapter.harness,
            harnessTargetId: binding.target.id,
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
    binding: HarnessBinding,
    opts: { invocationId: string; input?: QueueItem; harnessSessionId?: string },
  ): { record: QueueRun<HarnessBinding>; run: QueueRun<HarnessBinding>; settled: Promise<void> } {
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
    const queue = this.queueForContext(binding.contextId);
    const { run, settled } = queue.startRun(binding, opts.invocationId, opts.input);
    run.inputEventId = inputEventId;
    return { record: run, run, settled };
  }

  private async runQueueItem(input: QueueItem): Promise<void> {
    this.processing.set(input.contextId, {
      target: input.target,
      startedAt: Date.now(),
    });

    // 出队即入账、即落盘：用户输入是 AideSession 的事实，owner 是 controller——
    // 不等 harness 冷启动（codex 首启要 spawn → initialize → thread resume/start，
    // 可达数秒，期间 Transcript 必须已能看到这条输入）。落盘的是**原始输入** input.blocks：
    // <aide-sync> 注入只进 harness transport（syncContext / prepend），不进正典历史。
    let binding: HarnessBinding;
    let record: QueueRun<HarnessBinding>;
    let run: QueueRun<HarnessBinding>;
    let settled: Promise<void>;
    try {
      binding = this.bindingFor(input.contextId, input.target.id, input.invocationId);
      const context = this.options.records.meta.contexts[input.contextId];
      if (!context) throw new Error(`Execution context not found: ${input.contextId}`);
      ({ record, run, settled } = this.startInvocation(binding, {
        invocationId: input.invocationId,
        input,
        harnessSessionId: context.harnessSessions[input.target.id]?.harnessSessionId,
      }));
    } catch (error) {
      this.processing.delete(input.contextId);
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
      await this.ensureHarness(input.contextId, input.target.id);
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

      const records = this.options.records;
      const meta = records.meta.contexts[input.contextId]?.harnessSessions[input.target.id];
      const contextEpochId = binding.contextEpochId;
      if (!contextEpochId) {
        throw new Error(`${targetKey} opened without a ContextEpoch`);
      }
      // Receipt 是事实来源；syncedSeq 只给尚未产生新事件的旧会话做迁移兜底。
      const sinceSeq =
        Math.max(this.contextDeliveries.epoch(contextEpochId)?.throughSeq ?? meta?.syncedSeq ?? 0, meta?.contextAfterSeq ?? 0);
      const catchUp = buildTargetCatchUpContext(records, {
        target: binding.target,
        contextId: binding.contextId,
        sinceSeq,
        restoreHistory: binding.freshHarnessSession,
        budgetChars: this.options.mentionBudgetChars,
      });
      let blocks = input.blocks;
      let syncBlocks: PromptBlock[] | undefined;
      // 水位（syncedSeq）只在注入时前进到本批 throughSeq（并发正确性的关键：
      // throughSeq 固定在注入时点，turn 运行期间其它 harness 落盘的事件 seq 必然
      // 大于它，下一次注入自然回补；finalize 推尾水位则会永久越过它们）。
      let submitContext:
        | {
            snapshot: ContextSnapshotEnvelope;
            transport: ContextDeliveryTransport;
          }
        | undefined;
      if (catchUp) {
        const snapshot = this.contextDeliveries.prepare(binding, {
          invocationId: input.invocationId,
          harnessSessionId: binding.sessionIdentity()?.id,
          source: executionHistorySource(input.contextId),
          afterSeq: sinceSeq,
          throughSeq: catchUp.throughSeq,
          text: catchUp.text,
        });
        const syncBlock: PromptBlock = {
          type: "text",
          text: `<aide-sync>\n${catchUp.text}\n</aide-sync>`,
        };
        if (isContextSynchronizable(binding.adapter)) {
          await binding.adapter.syncContext(binding.ref, [syncBlock]);
          this.acceptContextDelivery(binding, snapshot, "sync_context");
        } else {
          // 随本 turn 的 sendTurn 送达（原生 side-channel 或 prepend）；两种形态共享
          // 同一水位语义：admission 通过后才推进，失败则下次重注入
          if (binding.adapter.capabilities.sync?.supported) {
            syncBlocks = [syncBlock];
            submitContext = { snapshot, transport: "submit_side_channel" };
          } else {
            blocks = [syncBlock, { type: "text", text: "\n\n" }, ...blocks];
            submitContext = { snapshot, transport: "prompt_prepend" };
          }
        }
      }

      if (!meta?.launchSnapshot) {
        throw new Error(
          `cannot prepare harness delivery for invocation ${record.invocationId}: missing HarnessLaunchSnapshot`,
        );
      }
      const attempt = this.deliveryAttempts.prepare(binding, {
        invocationId: record.invocationId,
        inputEventId: run.inputEventId,
        inputId: input.messageId,
        launchSnapshot: meta.launchSnapshot,
        harnessSessionId: meta.harnessSessionId ?? binding.sessionIdentity()?.id,
      });
      const promptInput: PromptInput = {
        invocationId: input.invocationId,
        messageId: input.messageId,
        blocks,
        ...(syncBlocks ? { syncBlocks } : {}),
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
      if (submitContext) {
        // admission 通过 ⇒ 随 sendTurn 送达的 sync 块（syncBlocks 或 prepend）已进入 harness
        // 输入：视为同步到 throughSeq。
        // admission 失败走 catch 上抛，水位不动，下次重新注入。
        this.acceptContextDelivery(
          binding,
          submitContext.snapshot,
          submitContext.transport,
        );
      }
      await settled;
    } catch (error) {
      // preparing 期间被取消、随后启动又失败：用户已收到 cancelled 终态并继续别的事，
      // 迟到的启动错误不再作为本 turn 的失败上抛（事件历史已闭合）
      if (record.status === "finalized") return;
      const detail = error instanceof Error ? error.message : String(error);
      this.options.records.log({
        level: "error",
        source: "aide",
        component: "controller.turn",
        harness: input.target.harness,
        harnessTargetId: targetKey,
        invocationId: input.invocationId,
        message: "harness startup or prompt admission failed",
        error: logError(error),
      });
      // 启动/admission 失败：合成结构化终态（error + idle + summary）——user_message 已
      // 落盘，必须有结局，不允许"输入消失且无历史"的半状态；随后仍上抛给 submit 调用方。
      this.synthesizeTerminal(run, { message: detail, stopReason: "error" });
      throw new Error(`Harness ${targetKey}: ${detail}`, {
        cause: error,
      });
    } finally {
      this.processing.delete(input.contextId);
      this.changed();
    }
  }

  /**
   * Receipt 必须先写入 Harness 事件日志，ContextEpoch 和 meta 缓存随后才前进。
   * adapter admission 仅证明 transport 接受，不扩大成“model 已读”的承诺。
   */
  private acceptContextDelivery(
    binding: HarnessBinding,
    snapshot: ContextSnapshotEnvelope,
    transport: ContextDeliveryTransport,
  ): void {
    const contextEpochId = binding.contextEpochId;
    if (!contextEpochId) {
      throw new Error(`${binding.target.id} cannot accept context without a ContextEpoch`);
    }
    const harnessSessionId = binding.sessionIdentity()?.id;
    this.contextDeliveries.accept(binding, snapshot, {
      contextEpochId,
      harnessSessionId,
      transport,
    });
    const records = this.options.records;
    const contextId = binding.contextId;
    const existing = records.meta.contexts[contextId]?.harnessSessions[binding.target.id];
    records.setContextHarnessSession(contextId, binding.target.id, {
      ...existing,
      harness: binding.adapter.harness,
      harnessSessionId:
        existing?.harnessSessionId ?? harnessSessionId,
      contextEpochId,
      syncedSeq: snapshot.payload.throughSeq,
    });
    binding.freshHarnessSession = false;
  }

  /**
   * HarnessEvent 与 Controller 自有 Event draft 的统一提交入口。AideSession 先完成
   * WAL record，再直接 reduce 当前 Projection；Controller 随后只处理 Invocation
   * scope 等协调逻辑。Ledger 不在这条实时链路上广播 Event。
   */
  private appendEvent(
    binding: HarnessBinding,
    ev: AnyEventDraft,
    source: EventSource,
  ): AnyEventEnvelope {
    const envelope = this.options.records.appendEvent({
      ...ev,
      source,
      harness: binding.adapter.harness,
      harnessTargetId: binding.target.id,
      contextId: binding.contextId,
    } as AnyNewEvent) as AnyEventEnvelope;
    if (envelope.kind === "state_update") {
      const p = envelope.payload;
      if (p.state === "idle") {
        // 终态一律按 invocationId 查表路由（不看 binding）。缺少 ID 的终态：
        // 已持久化留痕，但无法归属任何调用，不驱动生命周期（adapter 契约要求
        // 终态必带 invocationId，由契约测试钉住）。
        if (envelope.invocationId) {
          // Attempt 对账先于 Invocation 幂等收口：cancel grace 后迟到的 Harness idle 虽然不能
          // 二次 finalize Invocation，却仍是把 uncertain Attempt 收敛到终态的权威 Receipt。
          this.deliveryAttempts.observeTerminal(binding, envelope);
          this.finalize(envelope);
        }
      }
    }
    // Projection 已在 AideSession 内同步 reduce；终态对 Controller 私有台账的
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
        harnessTargetId: record.binding.target.id,
        contextId: record.contextId,
        invocationId: invocationId,
        payload: { level: "warning", title: INTERRUPTED_NOTICE_TITLE },
      });
    }

    records.summarizeInvocationEvent(invocationId);
    record.binding.freshHarnessSession = false;

    this.queueForContext(run.contextId).finishRun(run, stopReason);

    this.changed();
  }

  /**
   * controller 合成终态：可选的结构化 error 留痕 + idle，走统一事件管线（→ finalize）。
   * 使用方：cancel 宽限期到期 / cancel 请求失败 / preparing 取消（无 error，纯 cancelled）/
   * 启动与投递失败（stopReason:"error"）。
   */
  private synthesizeTerminal(
    record: Pick<QueueRun<HarnessBinding>, "binding" | "invocationId" | "status">,
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
   * 同步获取 HarnessBinding，调用入账后才启动：Adapter 构造和可信 Event sink 在这里绑定，
   * runQueueItem 因此能在 open() 完成之前落 user_message。实际启动生命周期由 binding 拥有。
   */
  private bindingKey(contextId: string, harnessTargetId: string): string {
    return `${contextId}\0${harnessTargetId}`;
  }

  private bindingFor(
    contextId: string,
    harnessTargetId: string,
    setupInvocationId?: string,
  ): HarnessBinding {
    const key = this.bindingKey(contextId, harnessTargetId);
    let binding = this.bindings.get(key);
    if (!binding) {
      const context = this.options.records.meta.contexts[contextId];
      if (!context) throw new Error(`Execution context not found: ${contextId}`);
      const target = this.targetFor(harnessTargetId);
      const adapter = this.options.createAdapter(target, {
        openApproval: (approval, context) =>
          this.openHarnessApproval(contextId, target.id, approval, context),
        log: (entry) =>
          this.options.records.log({ ...entry, harnessTargetId: target.id }),
        nativeEvent: (event) =>
          this.options.records.nativeEvent(
            target.id,
            target.harness,
            event,
            contextId,
          ),
      });
      let created!: HarnessBinding;
      created = new HarnessBinding({
        contextId,
        target,
        cwd: this.options.records.meta.cwd,
        adapter,
        records: this.options.records,
        setupInvocationId: setupInvocationId,
        modelPreference: this.options.modelPreferences?.[target.id],
        effortPreference: this.options.effortPreferences?.[target.id],
        eventSink: (event) => this.harnessHooks.acceptHarnessEvent(created, event),
      });
      binding = created;
      this.bindings.set(key, created);
    }
    return binding;
  }

  private async ensureHarness(contextId: string, harnessTargetId: string): Promise<HarnessBinding> {
    const key = this.bindingKey(contextId, harnessTargetId);
    const binding = this.bindingFor(contextId, harnessTargetId);
    binding.start();
    if (binding.isStarting) {
      try {
        await binding.ensure();
      } catch (error) {
        this.bindings.delete(key);
        throw error;
      } finally {
        this.changed();
      }
    }
    return binding;
  }

  private targetFor(harnessTargetId: string): HarnessTarget {
    const resolved = this.options.resolveTarget(harnessTargetId);
    if (!resolved) {
      throw new Error(`HarnessTarget not registered: ${harnessTargetId}`);
    }
    if (!resolved.id || resolved.id !== harnessTargetId || !resolved.harness) {
      throw new Error(
        `invalid HarnessTarget for ${harnessTargetId}: id=${resolved.id}, harness=${resolved.harness}`,
      );
    }
    return Object.freeze({ id: resolved.id, harness: resolved.harness });
  }

  private changed(): void {
    this.options.onChange?.();
  }
}
