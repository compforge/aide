import { resourceExecutionKey } from "../plugin/execution-context.ts";
import type { HarnessStore } from "./store.ts";
import { HarnessInvocationStore, type ScheduledHarnessInvocation, type HarnessInvocationSnapshot } from "./invocation.ts";
import type { ExecutionScope, VerbRequest, VerbResponse } from "../../protocol/verbs.ts";
import { logError, type LogSink } from "../logging.ts";
export type HarnessRequest = Extract<VerbRequest, { verb: "harness" }>;
/** The scheduler can request/cancel execution without accessing persistence or native bindings. */
export interface HarnessExecution {
  invoke(context: ExecutionScope, request: HarnessRequest): Promise<VerbResponse>;
  listHarnessInvocations(): readonly HarnessInvocationSnapshot[];
  cancelHarnessInvocation(id?: string): boolean;
  failExecution(executionId: string, error: string): void;
  failOrphans(): void;
}
export interface HarnessCallsOptions {
  records: HarnessStore;
  targets(): readonly { id: string }[];
  defaultTargetId?: string;
  enqueueHarnessInvocation(request: ScheduledHarnessInvocation): Promise<unknown> | void;
  cancelHarnessInvocation?(id: string): "queued" | "running" | undefined;
  now?(): Date;
  log?: LogSink;
}
/** @spec Owns invocation persistence, waiting and cancellation; resource scheduling only sees HarnessExecution.
 * @link docs/kernel.md
 */
export class HarnessCalls implements HarnessExecution {
  private readonly records: HarnessStore;
  private readonly harnessInvocations: HarnessInvocationStore;
  private readonly dispatchedHarnessInvocations = new Set<string>();
  private readonly enqueueHarnessInvocation: HarnessCallsOptions["enqueueHarnessInvocation"];
  private readonly cancelHostHarnessInvocation: HarnessCallsOptions["cancelHarnessInvocation"];
  private readonly now: () => Date;
  private readonly log?: LogSink;
  constructor(private readonly options: HarnessCallsOptions) {
    this.records = options.records;
    this.harnessInvocations = new HarnessInvocationStore(options.records);
    this.enqueueHarnessInvocation = options.enqueueHarnessInvocation;
    this.cancelHostHarnessInvocation = options.cancelHarnessInvocation;
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
  }
  listHarnessInvocations() {
    return this.harnessInvocations.list();
  }

  cancelHarnessInvocation(identifier?: string): boolean {
    const request = this.harnessInvocations.latestCancellable(
      identifier?.trim() || undefined,
    );
    if (!request) return false;

    const cancelled = this.harnessInvocations.cancel(
      request.invocationId,
      "user",
    );
    this.cancelHostHarnessInvocation?.(request.invocationId);
    return cancelled;
  }

  async invoke(context: ExecutionScope, request: HarnessRequest): Promise<VerbResponse> {
    const deadline = this.timestamp() + request.input.timeoutMs;
    const harnessTargetId = request.input.harnessTargetId ?? this.options.defaultTargetId;
    if (!harnessTargetId) throw new Error("harness() requires a HarnessTarget selection");
    if (
      !this.options.targets().some(
        (target) => target.id === harnessTargetId,
      )
    ) {
      throw new Error(
        `${request.verb}() references unknown HarnessTarget: ${harnessTargetId}`,
      );
    }
    const key = resourceExecutionKey(context);
    if (!this.records.meta.contexts[key]) this.records.setExecutionContext(key, { contextId: key, harnessSessions: {} });
    const snapshot = this.harnessInvocations.record({
      scope: context,
      invocation: {
        verb: request.verb,
        title: request.input.title,
        prompt: request.input.prompt,
        contextId: key,
        harnessTargetId,
        freshContext: request.input.freshContext,
      },
    });
    const scheduled = this.harnessInvocations.scheduled(snapshot.invocationId);
    if (scheduled) this.dispatchHarnessInvocation(scheduled);
    const terminal = await this.waitForHarnessInvocation(
      snapshot.invocationId,
      deadline,
    );
    if (terminal.phase === "completed" && terminal.result && terminal.contextId) {
      return Object.freeze({
        state: "success",
        value: {
          outcome: "completed" as const,
          invocationId: terminal.invocationId,
          result: (({ invocationId, ...result }) => result)(terminal.result),
        },
      });
    }
    if (terminal.phase === "cancelled") {
      if (terminal.cancellation?.reason === "user") {
        return Object.freeze({ state: "dismissed" });
      }
      if (terminal.cancellation?.reason === "timeout") {
        return Object.freeze({ state: "timeout" });
      }
      return Object.freeze({
        state: "failure",
        ...(terminal.cancellation?.detail === undefined
          ? {}
          : { error: terminal.cancellation.detail }),
      });
    }
    return Object.freeze({
      state: "failure",
      ...(terminal.failure?.detail === undefined
        ? {}
        : { error: terminal.failure.detail }),
    });
  }

  private async waitForHarnessInvocation(
    invocationId: string,
    deadline: number,
  ) {
    const remaining = deadline - this.timestamp();
    if (remaining <= 0) {
      this.harnessInvocations.cancel(invocationId, "timeout");
      this.cancelHostHarnessInvocation?.(invocationId);
      return await this.harnessInvocations.wait(invocationId);
    }
    const timer = setTimeout(() => {
      if (this.harnessInvocations.cancel(invocationId, "timeout")) {
        this.cancelHostHarnessInvocation?.(invocationId);
      }
    }, remaining);
    timer.unref?.();
    try {
      const terminal = await this.harnessInvocations.wait(invocationId);
      if (terminal.phase === "cancelled" && terminal.invocationId && this.records.projection.activeInvocations.has(terminal.invocationId)) {
        await new Promise<void>((resolve) => {
          const done = () => { if (!this.records.projection.activeInvocations.has(terminal.invocationId!)) { unsubscribe(); resolve(); } };
          const unsubscribe = this.records.subscribe(done);
          done();
        });
      }
      return terminal;
    } finally {
      clearTimeout(timer);
    }
  }

  private timestamp(): number {
    const value = this.now().getTime();
    if (Number.isNaN(value)) {
      throw new Error("Harness clock returned an invalid Date");
    }
    return value;
  }

  failExecution(executionId: string, error: string): void {
    for (
      const invocationId of
        this.harnessInvocations.failExecution(executionId, error)
    ) {
      this.cancelHostHarnessInvocation?.(invocationId);
    }
  }

  private dispatchHarnessInvocation(request: ScheduledHarnessInvocation): void {
    if (
      this.dispatchedHarnessInvocations.has(request.invocationId)
    ) {
      return;
    }
    this.dispatchedHarnessInvocations.add(request.invocationId);
    void Promise.resolve()
      .then(() => this.enqueueHarnessInvocation(request))
      .catch((error) => {
        this.harnessInvocations.fail(
          request.invocationId,
          "dispatch",
          error instanceof Error ? error.message : String(error),
        );
        this.log?.({
          level: "error",
          source: "aide",
          component: "plugin.harness-invocation",
          message: "HarnessInvocation dispatch failed",
          pluginInstanceId: request.pluginInstanceId,
          invocationId: request.invocationId,
          harnessTargetId: request.harnessTargetId,
          error: logError(error),
          attributes: { harnessInvocationId: request.invocationId },
        });
      });
  }
  failOrphans(): void { this.harnessInvocations.failOrphans("Plugin execution was interrupted by Core restart"); }
  close(): void { this.harnessInvocations.close(); }
}
