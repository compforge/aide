import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { InvocationExecutor, type InvocationExecutorOptions } from "../controller/index.ts";
import type { ApprovalResult } from "../approval/types.ts";
import { HarnessActivity, RECENT_INVOCATIONS } from "../harness/activity.ts";
import { ResourceSession } from "../harness/session.ts";
import { resourceExecutionKey } from "../plugin/execution-context.ts";
import type { ResourceClient } from "@compforge/aide-plugin";
import { emptyHarnessState, type HarnessState } from "../harness/state.ts";
import type { ScheduledHarnessInvocation } from "../harness/invocation.ts";
import { HarnessCalls, type HarnessExecution, type HarnessRequest } from "../harness/calls.ts";
import type { ExecutionScope } from "../../protocol/verbs.ts";
import { acquireWriterLock, releaseWriterLock } from "../store/lease.ts";
import { logError } from "../logging.ts";

export type ExecutionOptions = Omit<InvocationExecutorOptions, "records"> & { resources?(pluginInstanceId: string): ResourceClient };
type Target = { id: string; harness: string; model?: string; effort?: string };
const activeExecutors = new Set<string>();

/**
 * @spec Aide coordinates live calls and approvals; only native Harness sessions recover agent state.
 * @why Resource status owns recovery references. Execution progress is transient and never replayed.
 * @link docs/kernel.md
 */
export class ExecutionService implements HarnessExecution {
  private backend?: { records: HarnessActivity; controller: InvocationExecutor; calls: HarnessCalls; unsubscribe: () => void };
  private closing?: Promise<void>;
  private readonly usingContexts = new Map<string, number>();
  private readonly idleContexts = new Set<string>();
  private readonly retiringContexts = new Map<string, Promise<void>>();
  private readonly sessions = new Map<string, ResourceSession>();
  private readonly listeners = new Set<() => void>();
  private readonly targets = new Map<string, Target>();
  constructor(private readonly home: string, private readonly options: ExecutionOptions & {
    cwd: string; targets?: readonly Target[]; defaultTargetId?: string;
  }) {
    for (const target of options.targets ?? []) this.targets.set(target.id, { ...target });
  }
  private open(): NonNullable<ExecutionService["backend"]> {
    if (this.closing) throw new Error("Execution service is closing");
    if (this.backend) return this.backend;
    const dir = resolve(this.home);
    if (activeExecutors.has(dir)) throw new Error(`Harness execution is already active: ${dir}`);
    mkdirSync(dir, { recursive: true });
    if (!acquireWriterLock(join(dir, "execution.lock"))) throw new Error(`Harness execution is already active: ${dir}`);
    activeExecutors.add(dir);
    let records: HarnessActivity | undefined;
    try {
      records = new HarnessActivity(dir, resolve(this.options.cwd), async (contextId, targetId, session) => {
        const owner = this.sessions.get(`${contextId}\0${targetId}`);
        if (owner) await owner.write(session);
      });
      for (const target of this.targets.values()) this.configureTarget(records, target);
      const controller = new InvocationExecutor({ ...this.options, records });
      const calls = new HarnessCalls({ records,
        targets: () => [...this.targets.values()],
        defaultTargetId: this.options.defaultTargetId,
        enqueueHarnessInvocation: request => this.enqueue(request),
        cancelHarnessInvocation: id => this.cancel(id),
        log: entry => records!.log(entry),
      });
      const unsubscribe = records.subscribe(event => {
        for (const listener of this.listeners) {
          try { listener(); }
          catch (error) {
            records!.log({ level: "error", source: "aide", component: "execution.events",
              message: "Execution subscriber failed", error: logError(error),
              attributes: { seq: event.seq, kind: event.kind } });
          }
        }
      });
      this.backend = { records, controller, calls, unsubscribe };
      return this.backend;
    } catch (error) {
      void records?.closeLogs().catch(() => {});
      activeExecutors.delete(dir); releaseWriterLock(join(dir, "execution.lock"));
      throw error;
    }
  }
  private configureTarget(records: HarnessActivity, target: Target): void {
    records.setHarnessTarget(target.id, { ...target, harnessTargetId: target.id });
  }
  registerTarget(target: Target): void {
    this.targets.set(target.id, { ...target });
    if (this.backend) this.configureTarget(this.backend.records, target);
  }
  async invoke(scope: ExecutionScope, request: HarnessRequest) {
    const backend = this.open();
    const contextId = resourceExecutionKey(scope);
    this.usingContexts.set(contextId, (this.usingContexts.get(contextId) ?? 0) + 1);
    this.idleContexts.delete(contextId);
    try {
      await this.retiringContexts.get(contextId);
      const targetId = request.input.harnessTargetId ?? this.options.defaultTargetId;
      const target = targetId ? this.targets.get(targetId) : undefined;
      if (!target) throw new Error(`Unknown HarnessTarget: ${targetId}`);
      if (!backend.records.meta.contexts[contextId]) backend.records.setExecutionContext(contextId, { contextId, harnessSessions: {} });
      if (request.input.agentKey) {
        if (!this.options.resources) throw new Error("Harness native session requires ResourceClient access");
        const owner = new ResourceSession(this.options.resources(scope.pluginInstanceId), scope, request.input.agentKey, target.id, target.harness);
        const session = await owner.read();
        const context = backend.records.requireExecutionContext(contextId);
        if (!context.harnessSessions[target.id] && session) context.harnessSessions[target.id] = session;
        this.sessions.set(`${contextId}\0${target.id}`, owner);
      }
      return await backend.calls.invoke(scope, request);
    } finally {
      const remaining = this.usingContexts.get(contextId)! - 1;
      if (remaining) this.usingContexts.set(contextId, remaining);
      else {
        this.usingContexts.delete(contextId);
        this.idleContexts.add(contextId);
        await this.trimIdleContexts();
      }
    }
  }
  private async trimIdleContexts(): Promise<void> {
    const backend = this.backend!;
    const closing: Promise<void>[] = [];
    for (const contextId of this.idleContexts) {
      if (this.idleContexts.size <= RECENT_INVOCATIONS) break;
      this.idleContexts.delete(contextId);
      const retirement = (async () => {
        if (!await backend.controller.releaseContext(contextId)) return;
        delete backend.records.meta.contexts[contextId];
        for (const key of this.sessions.keys()) if (key.startsWith(`${contextId}\0`)) this.sessions.delete(key);
        for (const key of backend.records.projection.perContextTarget.keys()) {
          if (key.startsWith(`${contextId}\0`)) backend.records.projection.perContextTarget.delete(key);
        }
      })().finally(() => this.retiringContexts.delete(contextId));
      this.retiringContexts.set(contextId, retirement);
      closing.push(retirement);
    }
    await Promise.all(closing);
  }
  listHarnessInvocations() { return this.backend?.calls.listHarnessInvocations() ?? []; }
  cancelHarnessInvocation(id?: string) { return this.backend?.calls.cancelHarnessInvocation(id) ?? false; }
  failExecution(id: string, error: string) { this.backend?.calls.failExecution(id, error); }
  enqueue(request: ScheduledHarnessInvocation) {
    const { records, controller } = this.open();
    if (!records.meta.contexts[request.contextId]) records.setExecutionContext(request.contextId, { contextId: request.contextId, harnessSessions: {} });
    return controller.enqueueHarnessInvocation({
      pluginInstanceId: request.pluginInstanceId,
      harnessTargetId: request.harnessTargetId, contextId: request.contextId,
      freshContext: request.freshContext,
      source: { type: "plugin", pluginInstanceId: request.pluginInstanceId },
      messageId: request.messageId, invocationId: request.invocationId, blocks: [...request.blocks],
    });
  }
  async steer(invocationId: string, messageId: string, text: string) {
    return this.backend?.controller.steer(invocationId, messageId, text) ?? { accepted: false, reason: "not_running" };
  }
  cancel(id: string) { return this.backend?.controller.cancelHarnessInvocation(id); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  approvals() { return [...(this.backend?.records.projection.approvals.values() ?? [])]; }
  approval(id: string) { return this.backend?.records.projection.approvals.get(id)?.request; }
  resolveApproval(id: string, result: ApprovalResult): boolean {
    return !this.closing && (this.backend?.controller.completeApproval(id, result) ?? false);
  }
  /** Selected executions only; callers cannot modify the global projection. */
  view(invocationIds: readonly string[]): Pick<HarnessState, "harnessInputs" | "invocationSummaries" | "activeInvocations" | "messages" | "toolCalls" | "timeline"> {
    const ids = new Set(invocationIds), state = this.backend?.records.projection ?? emptyHarnessState();
    const inputs = new Map([...state.harnessInputs].filter(([, input]) => ids.has(input.invocationId)));
    const messageIds = new Set([...inputs.values()].map(input => input.messageId));
    const messages = new Map([...state.messages].filter(([id, message]) => messageIds.has(id) || (message.invocationId && ids.has(message.invocationId))));
    const toolCalls = new Map([...state.toolCalls].filter(([, tool]) => tool.invocationId && ids.has(tool.invocationId)));
    return structuredClone({ harnessInputs: inputs, messages, toolCalls,
      invocationSummaries: state.invocationSummaries.filter(turn => ids.has(turn.invocationId)),
      activeInvocations: new Map([...state.activeInvocations].filter(([id]) => ids.has(id))),
      timeline: state.timeline.filter(item => messages.has(item.id) || toolCalls.has(item.id)),
    });
  }
  close(): Promise<void> {
    return this.closing ??= (async () => {
      const backend = this.backend;
      if (!backend) return;
      try { await Promise.all(this.retiringContexts.values()); await backend.controller.close(); }
      finally {
        backend.calls.close(); backend.unsubscribe();
        try { await backend.records.closeLogs(); }
        finally { activeExecutors.delete(backend.records.dir); releaseWriterLock(join(backend.records.dir, "execution.lock")); }
      }
    })();
  }
}
