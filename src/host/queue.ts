import type { PromptBlock, StopReason } from "./event/index.ts";
import type { HarnessTarget } from "./harness/target.ts";
import type { HarnessInput, HarnessInputSource, HarnessInputStatus } from "./harness/input.ts";

export interface QueueSnapshot {
  messageId: string;
  enqueueSeq: number;
  invocationId: string;
  harnessTargetId: string;
  contextId: string;
  harness: string;
  blocks: PromptBlock[];
  source: HarnessInputSource;
  harnessInvocationId?: string;
}

export type QueueOutcome = "completed" | "recalled";

/** Queue-private continuation; it is never persisted or exposed to Harnesses. */
export interface QueueItem extends HarnessInput {
  /** First queued Event seq; orders Queue heads without creating another identity. */
  enqueueSeq: number;
  resolve?: (outcome: QueueOutcome) => void;
  reject?: (error: unknown) => void;
  outcome: Promise<QueueOutcome>;
}

interface QueueBinding {
  readonly contextId: string;
}

/** Active invocation state; admission and terminal recording own queue release. */
export interface QueueRun<TBinding extends QueueBinding> {
  readonly invocationId: string;
  readonly binding: TBinding;
  readonly contextId: string;
  readonly input?: QueueItem;
  readonly release: () => void;
  status: "active" | "finalized";
  stopReason?: StopReason;
  inputEventId?: string;
  cancelGraceTimer?: ReturnType<typeof setTimeout>;
}

export interface QueueSubmission {
  input: QueueItem;
  outcome: Promise<QueueOutcome>;
}

type BeforeInputTransition = (
  input: QueueItem,
  status: HarnessInputStatus,
  update?: { invocationId?: string; delivery?: HarnessInput["delivery"] },
) => number;

/**
 * One resource context's live execution queue. Business resources own pending work;
 * every mutation publishes a live update through beforeTransition.
 */
export class InvocationQueue<TBinding extends QueueBinding> {
  private readonly queue: QueueItem[] = [];
  private currentRun: QueueRun<TBinding> | undefined;

  constructor(
    readonly contextId: string,
    private readonly beforeTransition: BeforeInputTransition,
  ) {}

  get length(): number {
    return this.queue.length;
  }

  get queued(): readonly QueueItem[] {
    return this.queue;
  }

  get head(): QueueItem | undefined {
    return this.queue[0];
  }

  runs(): IterableIterator<QueueRun<TBinding>> {
    return (this.currentRun ? [this.currentRun] : []).values();
  }

  run(invocationId: string): QueueRun<TBinding> | undefined {
    return this.currentRun?.invocationId === invocationId ? this.currentRun : undefined;
  }

  get activeRun(): QueueRun<TBinding> | undefined {
    return this.currentRun?.status === "active" ? this.currentRun : undefined;
  }

  startRun(
    binding: TBinding,
    invocationId: string,
    input?: QueueItem,
  ): { run: QueueRun<TBinding>; settled: Promise<void> } {
    if (binding.contextId !== this.contextId) {
      throw new Error(
        `Queue ${this.contextId} cannot start a run for context ${binding.contextId}`,
      );
    }
    if (this.activeRun) {
      throw new Error(`Context ${this.contextId} already has an active Queue run`);
    }
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run: QueueRun<TBinding> = {
      invocationId,
      binding,
      contextId: binding.contextId,
      input,
      release,
      status: "active",
    };
    this.currentRun = run;
    return { run, settled };
  }

  finishRun(
    run: QueueRun<TBinding>,
    stopReason: StopReason | undefined,
  ): void {
    if (run.status === "finalized") return;
    run.status = "finalized";
    run.stopReason = stopReason;
    const terminal: HarnessInputStatus = stopReason === "cancelled" ? "interrupted" : "finalized";
    if (run.input) {
      this.beforeTransition(run.input, terminal);
      run.input.status = terminal;
    }
    if (this.currentRun?.invocationId === run.invocationId) this.currentRun = undefined;
    if (run.cancelGraceTimer) clearTimeout(run.cancelGraceTimer);
    run.cancelGraceTimer = undefined;
    run.release();
  }

  enqueue(
    target: HarnessTarget,
    blocks: PromptBlock[],
    options: {
      source?: HarnessInputSource;
      harnessInvocationId?: string;
      sourceProposedPlanId?: string;
      identity: { messageId: string; invocationId: string };
      parentEventId?: string;
      enqueueSeq?: number;
      restore?: boolean;
    },
  ): QueueSubmission {
    let resolve!: (outcome: QueueOutcome) => void;
    let reject!: (error: unknown) => void;
    const outcome = new Promise<QueueOutcome>((resolveOutcome, rejectOutcome) => {
      resolve = resolveOutcome;
      reject = rejectOutcome;
    });
    const input: QueueItem = {
      enqueueSeq: options?.enqueueSeq ?? 0,
      invocationId: options.identity.invocationId,
      messageId: options.identity.messageId,
      target,
      contextId: this.contextId,
      blocks,
      source: options?.source ?? { type: "user" },
      ...(options?.harnessInvocationId === undefined
        ? {}
        : { harnessInvocationId: options.harnessInvocationId }),
      ...(options?.parentEventId === undefined
        ? {}
        : { parentEventId: options.parentEventId }),
      status: "queued",
      delivery: "prompt",
      ...(options?.sourceProposedPlanId
        ? { sourceProposedPlanId: options.sourceProposedPlanId }
        : {}),
      resolve,
      reject,
      outcome,
    };
    if (options?.restore) {
      if (input.enqueueSeq < 1) {
        throw new Error(`restored Input ${input.messageId} is missing its queued Event seq`);
      }
    } else {
      input.enqueueSeq = this.beforeTransition(input, "queued");
    }
    this.queue.push(input);
    return { input, outcome };
  }

  dequeue(): QueueItem | undefined {
    const input = this.queue[0];
    if (input) this.beforeTransition(input, "admitted");
    const [removed] = this.queue.splice(0, 1);
    if (removed) removed.status = "admitted";
    return removed;
  }

  cancelHarnessInvocation(harnessInvocationId: string): QueueSnapshot | undefined {
    const index = this.queue.findIndex(
      (input) => input.harnessInvocationId === harnessInvocationId,
    );
    if (index < 0) return undefined;
    const input = this.queue[index];
    if (input) this.beforeTransition(input, "recalled");
    const [removed] = this.queue.splice(index, 1);
    if (!removed) return undefined;
    removed.status = "recalled";
    removed.resolve?.("recalled");
    return { messageId: removed.messageId, enqueueSeq: removed.enqueueSeq, invocationId: removed.invocationId, harnessTargetId: removed.target.id, contextId: removed.contextId, harness: removed.target.harness, blocks: removed.blocks, source: removed.source, harnessInvocationId: removed.harnessInvocationId };
  }
}
