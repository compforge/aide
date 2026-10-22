import { resourceExecutionKey } from "./execution-context.ts";
import type { ConnectorClient } from "@compforge/aide-plugin";
import { dispatchConnector, emptyConnectors } from "../../connector-client.ts";
import { newId } from "../event/ids.ts";
import {
  type LogSink,
  logError,
} from "../logging.ts";
import type { SessionHandle } from "../store/store.ts";
import {
  HarnessInvocationStore,
  type ScheduledHarnessInvocation,
} from "./harness-invocation.ts";
import type {
  ReconcileCapacity,
  ReconcileCapacityLease,
} from "../../reconcile/queue.ts";
import type { ReconcileSnapshot } from "./reconcile-snapshot.ts";

import type {
  ExecutionScope,
  VerbRequest,
  VerbResponse,
} from "../../protocol/verbs.ts";

type VerbSession = Pick<
  SessionHandle,
  "id" | "meta" | "ledger" | "projection" | "appendEvent" | "subscribe" | "requireExecutionContext" | "setExecutionContext"
>;

interface ActiveExecution {
  interrupted?: boolean;
  readonly scope: ExecutionScope;
  suspend<T>(wait: Promise<T>): Promise<T>;
}

export interface VerbOptions {
  actions?: Readonly<Record<string, (scope: ExecutionScope, input: unknown) => Promise<unknown>>>;
  session?: VerbSession;
  capacity: ReconcileCapacity;
  connectors?: ConnectorClient;
  snapshot: () => ReconcileSnapshot;
  selectedHarnessTargetId?: () => string | undefined;
  enqueueHarnessInvocation?(
    request: ScheduledHarnessInvocation,
  ): Promise<unknown> | void;
  cancelHarnessInvocation?(
    harnessInvocationId: string,
  ): "queued" | "running" | undefined;
  now?: () => Date;
  log?: LogSink;
  /** Optional Host executor for Harness calls from namespace-scoped Plugin Workers. */
  performVerb?(context: ExecutionScope, request: VerbRequest): Promise<VerbResponse>;
}

/** Plugin typed verbs and the live executions suspended while those verbs settle. */
export class Verb {
  private readonly connectors: ConnectorClient;
  private readonly actions: VerbOptions["actions"];
  private readonly session?: VerbSession;
  private readonly connectorCalls = new Map<string, { pluginInstanceId: string }>();
  private readonly capacity: ReconcileCapacity;
  private readonly snapshot: () => ReconcileSnapshot;
  private readonly selectedHarnessTargetId?: () => string | undefined;
  private readonly harnessInvocations?: HarnessInvocationStore;
  private readonly enqueueHarnessInvocation:
    VerbOptions["enqueueHarnessInvocation"];
  private readonly cancelHostHarnessInvocation:
    VerbOptions["cancelHarnessInvocation"];
  private readonly dispatchedHarnessInvocations = new Set<string>();
  private readonly remoteCompletions = new Map<string, () => void>();
  private readonly executions = new Map<string, ActiveExecution>();
  private readonly now: () => Date;
  private readonly log?: LogSink;
  private readonly performVerb?: NonNullable<VerbOptions["performVerb"]>;

  constructor(options: VerbOptions) {
    this.session = options.session;
    this.actions = options.actions;
    for (const event of options.session?.ledger.read() ?? []) {
      if (event.kind === "connector.started" && event.source.type === "plugin") {
        this.connectorCalls.set(event.payload.callId, { pluginInstanceId: event.source.pluginInstanceId });
      } else if (event.kind === "connector.settled") this.connectorCalls.delete(event.payload.callId);
    }
    this.capacity = options.capacity;
    this.connectors = options.connectors ?? emptyConnectors;
    this.snapshot = options.snapshot;
    this.selectedHarnessTargetId = options.selectedHarnessTargetId;
    this.enqueueHarnessInvocation = options.enqueueHarnessInvocation;
    this.cancelHostHarnessInvocation = options.cancelHarnessInvocation;
    this.now = options.now ?? (() => new Date());
    this.log = options.log;
    this.performVerb = options.performVerb;
    if (options.session) {
      this.harnessInvocations = new HarnessInvocationStore(options.session);
    }
  }

  executionScope(executionId: string): ExecutionScope {
    const execution = this.executions.get(executionId);
    if (!execution) throw new Error(`Plugin execution is not active: ${executionId}`);
    return execution.scope;
  }

  interruptExecution(executionId: string): void {
    const execution = this.executions.get(executionId);
    if (!execution) return;
    execution.interrupted = true;
    for (const invocation of this.listHarnessInvocations()) {
      if (invocation.executionId === executionId) this.cancelHarnessInvocation(invocation.invocationId);
    }
  }

  listHarnessInvocations() {
    return this.harnessInvocations?.list() ?? [];
  }

  cancelHarnessInvocation(identifier?: string): boolean {
    const request = this.harnessInvocations?.latestCancellable(
      identifier?.trim() || undefined,
    );
    if (!request || !this.harnessInvocations) return false;

    const cancelled = this.harnessInvocations.cancel(
      request.invocationId,
      "user",
    );
    this.cancelHostHarnessInvocation?.(request.invocationId);
    return cancelled;
  }

  async invoke(
    context: ExecutionScope,
    request: VerbRequest,
  ): Promise<VerbResponse> {
    const execution = this.executions.get(context.executionId);
    if (
      !execution ||
      execution.scope.pluginInstanceId !== context.pluginInstanceId ||
      execution.scope.namespace !== context.namespace
    ) {
      throw new Error(`Plugin execution is not active: ${context.executionId}`);
    }
    const operation = this.perform(context, request).catch((error) =>
      Object.freeze({
        state: "failure" as const,
        error: error instanceof Error ? error.message : String(error),
      })
    );
    return await execution.suspend(operation);
  }

  async beginRemote(scope: ExecutionScope): Promise<void> {
    let release!: () => void;
    const completion = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    let failed!: (error: unknown) => void;
    const admitted = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
    const running = this.trackExecution(scope, async (wait) => await wait, async () => {
      this.remoteCompletions.set(scope.executionId, release);
      ready();
      await completion;
    });
    void running.catch(failed);
    await admitted;
  }

  endRemote(executionId: string): void {
    this.remoteCompletions.get(executionId)?.();
    this.remoteCompletions.delete(executionId);
  }

  async execute<T>(
    scope: ExecutionScope,
    localLease: ReconcileCapacityLease,
    execute: () => Promise<T>,
  ): Promise<T> {
    return await this.capacity.run(async (globalLease) => {
      return await this.trackExecution(
        scope,
        async <U>(wait: Promise<U>): Promise<U> =>
          await globalLease.suspend(localLease.suspend(wait)),
        execute,
      );
    });
  }

  /** Hook notification does not consume the reconcile workqueue capacity. */
  async executeHook<T>(
    scope: ExecutionScope,
    execute: () => Promise<T>,
  ): Promise<T> {
    return await this.trackExecution(scope, async (wait) => await wait, execute);
  }

  failInstance(pluginInstanceId: string, error: string): void {
    for (const [id, call] of this.connectorCalls) if (call.pluginInstanceId === pluginInstanceId) this.settleConnector(id, "interrupted", error);
    for (const execution of this.executions.values()) {
      if (execution.scope.pluginInstanceId !== pluginInstanceId) continue;
      this.failExecution(execution.scope.executionId, error);
      this.endRemote(execution.scope.executionId);
    }
  }

  failAll(error: string): void {
    for (const id of this.connectorCalls.keys()) this.settleConnector(id, "interrupted", error);
    for (const execution of this.executions.values()) {
      this.failExecution(execution.scope.executionId, error);
      this.endRemote(execution.scope.executionId);
    }
  }

  failOrphans(): void {
    for (const id of this.connectorCalls.keys()) this.settleConnector(id, "interrupted", "Core restarted; external outcome is unknown");
    this.harnessInvocations?.failOrphans(
      "Plugin execution was interrupted by Core restart",
    );
  }

  close(): void {
    this.harnessInvocations?.close();
  }

  private settleConnector(callId: string, outcome: "success" | "failure" | "timeout" | "interrupted", error?: string): void {
    const call = this.connectorCalls.get(callId);
    if (!call) return; // A late provider completion cannot overwrite a recorded interruption.
    this.session?.appendEvent({ kind: "connector.settled", source: { type: "plugin", pluginInstanceId: call.pluginInstanceId },
      payload: { callId, outcome, ...(error ? { error } : {}) } });
    this.connectorCalls.delete(callId);
  }

  private async perform(
    context: ExecutionScope,
    request: VerbRequest,
  ): Promise<VerbResponse> {
    if (this.executions.get(context.executionId)?.interrupted) return { state: "dismissed" };
    if (request.verb === "action") {
      const handler = this.actions?.[`${context.pluginInstanceId}/${request.name}`];
      if (!handler) throw new Error(`Plugin action is not installed: ${context.pluginInstanceId}/${request.name}`);
      const value = await handler(context, request.input);
      this.log?.({ level: "info", source: "plugin", component: "verb.action", pluginInstanceId: context.pluginInstanceId,
        message: "Plugin action completed", attributes: { action: request.name, executionId: context.executionId } });
      return { state: "success", value };
    }

    if (request.verb === "connector") {
      const callId = newId("cc");
      // @spec Persist intent before dispatch; restart records an unknown outcome instead of replaying external effects.
      this.session?.appendEvent({ kind: "connector.started", source: { type: "plugin", pluginInstanceId: context.pluginInstanceId },
        payload: { callId, executionId: context.executionId, request: request.input.request,
          resourceRef: context.resourceRef, attributes: context.attributes } });
      this.connectorCalls.set(callId, { pluginInstanceId: context.pluginInstanceId });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          dispatchConnector(this.connectors, request.input.request).then((value) => ({ state: "success" as const, value })),
          new Promise<{ state: "timeout" }>((resolve) => { timer = setTimeout(() => resolve({ state: "timeout" }), request.input.timeoutMs); }),
        ]);
        this.settleConnector(callId, result.state);
        return result;
      } catch (error) {
        this.settleConnector(callId, "failure", error instanceof Error ? error.message : String(error));
        throw error;
      } finally { if (timer) clearTimeout(timer); }
    }
    if (this.performVerb) return await this.performVerb(context, request);
    if (!this.harnessInvocations || !this.enqueueHarnessInvocation) {
      throw new Error(
        `Plugin verb ${request.verb}() requires HarnessInvocation support`,
      );
    }

    const deadline = this.timestamp() + request.input.timeoutMs;
    const harnessTargetId = request.input.harnessTargetId ?? this.selectedHarnessTargetId?.();
    if (!harnessTargetId) throw new Error("harness() requires a HarnessTarget selection");
    if (
      !this.snapshot().harnessTargets.some(
        (target) => target.id === harnessTargetId,
      )
    ) {
      throw new Error(
        `${request.verb}() references unknown HarnessTarget: ${harnessTargetId}`,
      );
    }
    if (this.executions.get(context.executionId)?.interrupted) return { state: "dismissed" };
    const key = resourceExecutionKey(context);
    if (!this.session?.meta.contexts[key]) this.session?.setExecutionContext(key, { contextId: key, harnessSessions: {} });
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
    if (this.executions.get(context.executionId)?.interrupted) this.cancelHarnessInvocation(snapshot.invocationId);
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

  private async trackExecution<T>(
    scope: ExecutionScope,
    suspend: ActiveExecution["suspend"],
    execute: () => Promise<T>,
  ): Promise<T> {
    if (this.executions.has(scope.executionId)) {
      throw new Error(`Plugin execution already exists: ${scope.executionId}`);
    }
    this.executions.set(scope.executionId, { scope, suspend });
    let failure = "Plugin execution completed before its verb";
    try {
      return await execute();
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.failExecution(scope.executionId, failure);
      this.executions.delete(scope.executionId);
    }
  }

  private async waitForHarnessInvocation(
    invocationId: string,
    deadline: number,
  ) {
    if (!this.harnessInvocations) {
      throw new Error("HarnessInvocation store is unavailable");
    }
    const remaining = deadline - this.timestamp();
    if (remaining <= 0) {
      this.harnessInvocations.cancel(invocationId, "timeout");
      this.cancelHostHarnessInvocation?.(invocationId);
      return await this.harnessInvocations.wait(invocationId);
    }
    const timer = setTimeout(() => {
      if (this.harnessInvocations?.cancel(invocationId, "timeout")) {
        this.cancelHostHarnessInvocation?.(invocationId);
      }
    }, remaining);
    timer.unref?.();
    try {
      const terminal = await this.harnessInvocations.wait(invocationId);
      if (terminal.phase === "cancelled" && terminal.invocationId && this.session?.projection.activeInvocations.has(terminal.invocationId)) {
        await new Promise<void>((resolve) => {
          const done = () => { if (!this.session!.projection.activeInvocations.has(terminal.invocationId!)) { unsubscribe(); resolve(); } };
          const unsubscribe = this.session!.subscribe(done);
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
      throw new Error("plugin Verb now() returned an invalid Date");
    }
    return value;
  }

  private failExecution(executionId: string, error: string): void {
    for (
      const invocationId of
        this.harnessInvocations?.failExecution(executionId, error) ?? []
    ) {
      this.cancelHostHarnessInvocation?.(invocationId);
    }
  }

  private dispatchHarnessInvocation(request: ScheduledHarnessInvocation): void {
    if (
      !this.enqueueHarnessInvocation ||
      this.dispatchedHarnessInvocations.has(request.invocationId)
    ) {
      return;
    }
    this.dispatchedHarnessInvocations.add(request.invocationId);
    void Promise.resolve()
      .then(() => this.enqueueHarnessInvocation!(request))
      .catch((error) => {
        this.harnessInvocations?.fail(
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
}
