import type { LogSink, LogAttributes } from "../../logging.ts";
import type { ReconcileRetryBackoff } from "../controller.ts";

interface Recovery {
  error: unknown;
  failed: boolean;
  abort: AbortController;
  done: Promise<void>;
}

/** @spec Recovery withdraws the failed binding and awaits application reconciliation before reactivation.
 * @spec Repeated failures back off; disable and close cancel pending restarts and await in-flight cleanup.
 * @why Restoring a Runner restores scheduling, never replays an interrupted verb or its async stack.
 * @case tests/runner-recovery.test.ts
 * @link docs/plugin/README.md#host-与-runner
 */
export class RunnerRecovery {
  private readonly pending = new Map<string, Recovery>();
  private readonly attempts = new Map<string, { count: number; recoveredAt?: number }>();
  private closed = false;
  constructor(private readonly options: {
    backoff: ReconcileRetryBackoff;
    log?: LogSink;
    enabled(id: string): boolean;
    prepare(id: string, error: unknown): Promise<void>;
    activate(id: string): Promise<void>;
  }) {}

  has(id: string): boolean { return this.pending.has(id); }
  fail(id: string, error: unknown): void {
    if (this.closed) return;
    const existing = this.pending.get(id);
    if (existing) { existing.error = error; existing.failed = true; return; }
    const recovery: Recovery = { error, failed: false, abort: new AbortController(), done: Promise.resolve() };
    this.pending.set(id, recovery);
    recovery.done = this.restore(id, recovery).finally(() => {
      if (this.pending.get(id) === recovery) this.pending.delete(id);
    });
  }

  async cancel(id: string): Promise<void> {
    const recovery = this.pending.get(id);
    recovery?.abort.abort();
    await recovery?.done;
    this.attempts.delete(id);
  }
  async close(): Promise<void> {
    this.closed = true;
    await Promise.all([...this.pending.keys()].map(id => this.cancel(id)));
  }

  private async restore(id: string, recovery: Recovery): Promise<void> {
    const active = () => !this.closed && !recovery.abort.signal.aborted && this.options.enabled(id);
    while (active()) {
      recovery.failed = false;
      try { await this.options.prepare(id, recovery.error); }
      catch (error) { recovery.error = error; recovery.failed = true; }
      if (!active()) return;
      const previous = this.attempts.get(id);
      const count = previous?.recoveredAt && Date.now() - previous.recoveredAt >= 60_000 ? 1 : (previous?.count ?? 0) + 1;
      this.attempts.set(id, { count });
      const delayMs = Math.min(this.options.backoff.maxDelayMs, this.options.backoff.initialDelayMs * 2 ** Math.min(count - 1, 30));
      this.report("warn", "Plugin Runner restart scheduled", id, { attempt: count, delayMs, error: String(recovery.error) });
      await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); recovery.abort.signal.removeEventListener("abort", finish); resolve(); };
        const timer = setTimeout(finish, delayMs);
        timer.unref?.();
        recovery.abort.signal.addEventListener("abort", finish, { once: true });
      });
      if (!active()) return;
      if (recovery.failed) continue;
      try {
        await this.options.activate(id);
        if (!active()) return;
        if (recovery.failed) continue;
        this.attempts.set(id, { count, recoveredAt: Date.now() });
        this.report("info", "Plugin Runner recovered", id, { attempt: count });
        return;
      } catch (error) {
        recovery.error = error;
        this.report("error", "Plugin Runner restart failed", id, { attempt: count, error: String(error) });
      }
    }
  }

  private report(level: "info" | "warn" | "error", message: string, pluginInstanceId: string, attributes: LogAttributes): void {
    try { this.options.log?.({ level, source: "aide", component: "plugin.runner", message, pluginInstanceId, attributes }); }
    catch { /* Diagnostics cannot interrupt recovery. */ }
  }
}
