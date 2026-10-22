import type { ConnectorClient } from "@compforge/aide-plugin";
import { dispatchConnector, emptyConnectors } from "../../connector-client.ts";
import {
  type LogSink,
} from "../logging.ts";
import type { HarnessExecution } from "../harness/calls.ts";
import { ConnectorCalls } from "../connector/calls.ts";
import type {
  ReconcileCapacity,
  ReconcileCapacityLease,
} from "../../reconcile/queue.ts";

import type {
  ExecutionScope,
  VerbRequest,
  VerbResponse,
} from "../../protocol/verbs.ts";

interface ActiveExecution {
  interrupted?: boolean;
  readonly scope: ExecutionScope;
  suspend<T>(wait: Promise<T>): Promise<T>;
}

export interface VerbOptions {
  actions?: Readonly<Record<string, (scope: ExecutionScope, input: unknown) => Promise<unknown>>>;
  harness?: HarnessExecution;
  connectorCalls?: ConnectorCalls;
  capacity: ReconcileCapacity;
  connectors?: ConnectorClient;
  log?: LogSink;
  /** Optional Host executor for Harness calls from namespace-scoped Plugin Workers. */
  performVerb?(context: ExecutionScope, request: VerbRequest): Promise<VerbResponse>;
}

/** Plugin typed verbs and the live executions suspended while those verbs settle. */
export class Verb {
  private readonly connectors: ConnectorClient;
  private readonly actions: VerbOptions["actions"];
  private readonly connectorCalls?: ConnectorCalls;
  private readonly harness?: HarnessExecution;
  private readonly capacity: ReconcileCapacity;
  private readonly remoteCompletions = new Map<string, () => void>();
  private readonly executions = new Map<string, ActiveExecution>();
  private readonly log?: LogSink;
  private readonly performVerb?: NonNullable<VerbOptions["performVerb"]>;

  constructor(options: VerbOptions) {
    this.harness = options.harness;
    this.actions = options.actions;
    this.connectorCalls = options.connectorCalls;
    this.capacity = options.capacity;
    this.connectors = options.connectors ?? emptyConnectors;
    this.log = options.log;
    this.performVerb = options.performVerb;
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

  listHarnessInvocations() { return this.harness?.listHarnessInvocations() ?? []; }
  cancelHarnessInvocation(identifier?: string): boolean { return this.harness?.cancelHarnessInvocation(identifier) ?? false; }

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
    this.connectorCalls?.failInstance(pluginInstanceId, error);
    for (const execution of this.executions.values()) {
      if (execution.scope.pluginInstanceId !== pluginInstanceId) continue;
      this.failExecution(execution.scope.executionId, error);
      this.endRemote(execution.scope.executionId);
    }
  }

  failAll(error: string): void {
    this.connectorCalls?.failAll(error);
    for (const execution of this.executions.values()) {
      this.failExecution(execution.scope.executionId, error);
      this.endRemote(execution.scope.executionId);
    }
  }

  failOrphans(): void {
    this.connectorCalls?.failOrphans();
    this.harness?.failOrphans();
  }
  close(): void { this.connectorCalls?.close(); }

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
      if (!this.connectorCalls) throw new Error("connector() requires persistent call storage");
      const callId = this.connectorCalls.start(context, request.input.request);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race([
          dispatchConnector(this.connectors, request.input.request).then((value) => ({ state: "success" as const, value })),
          new Promise<{ state: "timeout" }>((resolve) => { timer = setTimeout(() => resolve({ state: "timeout" }), request.input.timeoutMs); }),
        ]);
        this.connectorCalls.settle(callId, result.state);
        return result;
      } catch (error) {
        this.connectorCalls.settle(callId, "failure", error instanceof Error ? error.message : String(error));
        throw error;
      } finally { if (timer) clearTimeout(timer); }
    }
    if (this.performVerb) return await this.performVerb(context, request);
    if (!this.harness) throw new Error("harness() requires a configured Harness execution capability");
    return await this.harness.invoke(context, request);
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

  private failExecution(executionId: string, error: string): void {
    this.harness?.failExecution(executionId, error);
  }
}
