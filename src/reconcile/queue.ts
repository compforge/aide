import type {
  ReconcileKey,
  ReconcileScope,
} from "../protocol/reconcile.ts";
import {
  sameReconcileScope,
} from "./reconcile-scope.ts";

interface QueuedReconcile {
  key: ReconcileKey;
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface DueReconcile {
  key: ReconcileKey;
  dueAtMs: number;
}

export interface ReconcileQueueOptions {
  maxConcurrency?: number;
  execute(key: ReconcileKey, lease: ReconcileCapacityLease): Promise<void>;
  onError?(key: ReconcileKey, error: unknown): void;
}

export interface DueQueueOptions {
  now?: () => Date;
  onDue(key: ReconcileKey): void;
}

export class ReconcileCapacity {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("maxTotalConcurrency must be a positive integer");
    }
  }

  async run<T>(
    execute: (lease: ReconcileCapacityLease) => Promise<T>,
  ): Promise<T> {
    const admission = this.acquire();
    if (admission) await admission;
    let held = true;
    let finished = false;
    const lease: ReconcileCapacityLease = Object.freeze({
      suspend: async <U>(wait: Promise<U>): Promise<U> => {
        if (held) {
          held = false;
          this.release();
        }
        try {
          return await wait;
        } finally {
          if (!held && !finished) {
            // The live continuation already owns admission; only new work queues.
            this.active += 1;
            held = true;
          }
        }
      },
    });
    try {
      return await execute(lease);
    } finally {
      finished = true;
      if (held) this.release();
    }
  }

  private acquire(): Promise<void> | undefined {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    this.active -= 1;
    if (this.active < this.limit) {
      const next = this.waiting.shift();
      if (next) {
        this.active += 1;
        next();
      }
    }
  }
}

/**
 * @spec Capacity limits new Reconcile admission. Verb waits release capacity; settled continuations resume without queuing, even above the limit.
 * @rule While resumed work fills or exceeds the limit, no new execution is admitted. Same-resource serialization spans all waits.
 * @rule Parallel waits share one lease; their continuations must not restore capacity more than once or after execution ends.
 * @link docs/kernel.md
 * @case tests/reconcile-capacity.test.ts
 * @case tests/plugin-runner.test.ts
 */
export interface ReconcileCapacityLease {
  suspend<T>(wait: Promise<T>): Promise<T>;
}

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function reconcileKeyId(key: ReconcileKey): string {
  return JSON.stringify([
    key.pluginInstanceId,
    key.namespace,
    key.resourceApiVersion,
    key.resourceKind,
    key.resourceId,
    key.controllerName ?? "",
  ]);
}

function queuedReconcile(key: ReconcileKey): QueuedReconcile {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { key, completion, resolve, reject };
}

function timestamp(now: () => Date, label: string): number {
  const value = now();
  if (Number.isNaN(value.getTime())) throw new Error(`${label} now() returned an invalid Date`);
  return value.getTime();
}

/**
 * Controller 进程内 workqueue。语义对齐 controller-runtime/client-go：
 * pending key 去重；运行期间的新触发只保留一次 dirty follow-up。
 */
export class ReconcileQueue {
  private readonly pending = new Map<string, QueuedReconcile>();
  private readonly admitting = new Set<string>();
  private readonly running = new Set<string>();
  private readonly capacity: ReconcileCapacity;
  private readonly execute: ReconcileQueueOptions["execute"];
  private readonly onError: ReconcileQueueOptions["onError"];
  private closed = false;

  constructor(options: ReconcileQueueOptions) {
    const maxConcurrency = options.maxConcurrency ?? 1;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    this.capacity = new ReconcileCapacity(maxConcurrency);
    this.execute = options.execute;
    this.onError = options.onError;
  }

  enqueue(key: ReconcileKey): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("plugin Controller is closed"));
    }
    const id = reconcileKeyId(key);
    const existing = this.pending.get(id);
    if (existing) return existing.completion;

    const item = queuedReconcile(key);
    this.pending.set(id, item);
    this.drain();
    return item.completion;
  }

  /** Drop a dirty follow-up after the running reconcile deletes its Resource. */
  forgetPending(key: ReconcileKey): void {
    const item = this.pending.get(reconcileKeyId(key));
    if (!item) return;
    this.pending.delete(reconcileKeyId(key));
    item.resolve();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("plugin Controller is closed");
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }

  private drain(): void {
    if (this.closed) return;
    for (const [id, item] of this.pending) {
      if (this.admitting.has(id) || this.running.has(id)) continue;
      this.admitting.add(id);
      void this.executeOne(id, item);
    }
  }

  private async executeOne(id: string, item: QueuedReconcile): Promise<void> {
    let admitted = false;
    try {
      await this.capacity.run(async (lease) => {
        if (this.pending.get(id) !== item) return;
        this.pending.delete(id);
        this.running.add(id);
        admitted = true;
        await this.execute(item.key, lease);
      });
      if (!admitted) return;
      item.resolve();
    } catch (error) {
      if (!admitted) return;
      item.reject(error);
      try {
        this.onError?.(item.key, error);
      } catch {
        // Queue completion must not be replaced by an observer failure.
      }
    } finally {
      this.admitting.delete(id);
      if (admitted) this.running.delete(id);
      this.drain();
    }
  }
}

/**
 * Manager 级动态唤醒队列。所有 Controller 共享一个 timer；持久真相仍在
 * PluginResourceStore control state，当前堆只负责本进程唤醒。
 * @spec Deadline updates and cancellation are O(log n), with one heap entry per live key.
 * @case tests/reconcile-due.test.ts
 * @link docs/kernel.md
 */
export class ReconcileDueQueue {
  private readonly entries = new Map<string, DueReconcile>();
  private readonly heap: string[] = [];
  private readonly positions = new Map<string, number>();
  private swap(a: number, b: number): void {
    [this.heap[a], this.heap[b]] = [this.heap[b]!, this.heap[a]!];
    this.positions.set(this.heap[a]!, a); this.positions.set(this.heap[b]!, b);
  }
  private earlier(a: number, b: number): boolean {
    return this.entries.get(this.heap[a]!)!.dueAtMs < this.entries.get(this.heap[b]!)!.dueAtMs;
  }
  private repair(index: number): void {
    while (index > 0 && this.earlier(index, (index - 1) >> 1)) {
      const parent = (index - 1) >> 1; this.swap(index, parent); index = parent;
    }
    while (index * 2 + 1 < this.heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.heap.length && this.earlier(child + 1, child)) child++;
      if (!this.earlier(child, index)) break;
      this.swap(index, child); index = child;
    }
  }
  private remove(id: string): boolean {
    const index = this.positions.get(id);
    if (index === undefined) return false;
    const last = this.heap.pop()!;
    this.entries.delete(id); this.positions.delete(id);
    if (index < this.heap.length) {
      this.heap[index] = last; this.positions.set(last, index); this.repair(index);
    }
    return true;
  }
  private readonly now: () => Date;
  private readonly onDue: DueQueueOptions["onDue"];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(options: DueQueueOptions) {
    this.now = options.now ?? (() => new Date());
    this.onDue = options.onDue;
  }

  schedule(key: ReconcileKey, dueAt: Date | null): void {
    const id = reconcileKeyId(key);
    if (dueAt === null) {
      if (this.remove(id)) this.arm();
      return;
    }
    const dueAtMs = dueAt.getTime();
    if (Number.isNaN(dueAtMs)) throw new Error("reconcile due time must be a valid Date");
    const current = this.entries.get(id);
    if (current?.dueAtMs === dueAtMs) return;
    this.entries.set(id, { key, dueAtMs });
    if (!this.positions.has(id)) { this.positions.set(id, this.heap.length); this.heap.push(id); }
    this.repair(this.positions.get(id)!);
    this.arm();
  }

  removeScope(scope: ReconcileScope): void {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (!sameReconcileScope(entry.key, scope)) continue;
      this.remove(id);
      changed = true;
    }
    if (changed) this.arm();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.entries.clear();
    this.heap.length = 0;
    this.positions.clear();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    const earliest = this.heap.length ? this.entries.get(this.heap[0]!)!.dueAtMs : Infinity;
    if (!Number.isFinite(earliest)) return;

    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, earliest - timestamp(this.now, "plugin due queue")),
    );
    this.timer = setTimeout(() => this.fire(), delay);
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = undefined;
    const nowMs = timestamp(this.now, "plugin due queue");
    const due: ReconcileKey[] = [];
    while (this.heap.length) {
      const id = this.heap[0]!, entry = this.entries.get(id)!;
      if (entry.dueAtMs > nowMs) break;
      this.remove(id);
      due.push(entry.key);
    }
    this.arm();
    for (const key of due) this.onDue(key);
  }
}
