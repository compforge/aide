import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { InvocationExecutor, type InvocationExecutorOptions } from "../controller/index.ts";
import type { ApprovalResult } from "../approval/types.ts";
import { openHarnessStore, harnessStorageDirectory, type HarnessStore } from "../harness/store.ts";
import { emptyHarnessState, type HarnessState } from "../harness/state.ts";
import type { ScheduledHarnessInvocation } from "../harness/invocation.ts";
import { HarnessCalls, type HarnessExecution, type HarnessRequest } from "../harness/calls.ts";
import type { ExecutionScope } from "../../protocol/verbs.ts";
import { acquireWriterLock, releaseWriterLock } from "../store/lease.ts";
import { logError } from "../logging.ts";

export type ExecutionOptions = Omit<InvocationExecutorOptions, "records">;
type Target = { id: string; harness: string; model?: string; effort?: string };
const activeStores = new Set<string>();

/**
 * @spec Harness owns its storage, native approvals and shutdown. Resource-only runtimes never open it.
 * @why Existing state is recovered before new calls; no Reconcile stack is replayed.
 * @link docs/kernel.md
 */
export class ExecutionService implements HarnessExecution {
  private backend?: { records: HarnessStore; controller: InvocationExecutor; calls: HarnessCalls; unsubscribe: () => void };
  private closing?: Promise<void>;
  private readonly listeners = new Set<() => void>();
  private readonly targets = new Map<string, Target>();
  constructor(private readonly home: string, private readonly options: ExecutionOptions & {
    cwd: string; targets?: readonly Target[]; defaultTargetId?: string;
  }) {
    for (const target of options.targets ?? []) this.targets.set(target.id, { ...target });
    if (existsSync(join(harnessStorageDirectory(home), "meta.json"))) this.open();
  }
  private open(): NonNullable<ExecutionService["backend"]> {
    if (this.closing) throw new Error("Execution service is closing");
    if (this.backend) return this.backend;
    const dir = harnessStorageDirectory(this.home);
    if (activeStores.has(dir)) throw new Error(`Harness storage is already active: ${dir}`);
    mkdirSync(dir, { recursive: true });
    if (!acquireWriterLock(join(dir, "lock"))) throw new Error(`Harness storage is already active: ${dir}`);
    activeStores.add(dir);
    let records: HarnessStore | undefined;
    try {
      records = openHarnessStore(this.home, this.options.cwd);
      const cwd = resolve(this.options.cwd);
      if (records.meta.cwd !== cwd) records.updateMeta({ cwd, contexts: Object.fromEntries(
        Object.entries(records.meta.contexts).map(([id, context]) => [id, { ...context, harnessSessions: {} }])) });
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
      activeStores.delete(dir); releaseWriterLock(join(dir, "lock"));
      throw error;
    }
  }
  private configureTarget(records: HarnessStore, target: Target): void {
    const previous = records.meta.harnessTargets[target.id];
    if (previous && previous.harness !== target.harness) records.updateMeta({ contexts: Object.fromEntries(
      Object.entries(records.meta.contexts).map(([id, context]) => {
        const { [target.id]: _old, ...harnessSessions } = context.harnessSessions;
        return [id, { ...context, harnessSessions }];
      })) });
    records.setHarnessTarget(target.id, { ...target, harnessTargetId: target.id });
  }
  registerTarget(target: Target): void {
    this.targets.set(target.id, { ...target });
    if (this.backend) this.configureTarget(this.backend.records, target);
  }
  invoke(scope: ExecutionScope, request: HarnessRequest) { return this.open().calls.invoke(scope, request); }
  listHarnessInvocations() { return this.backend?.calls.listHarnessInvocations() ?? []; }
  cancelHarnessInvocation(id?: string) { return this.backend?.calls.cancelHarnessInvocation(id) ?? false; }
  failExecution(id: string, error: string) { this.backend?.calls.failExecution(id, error); }
  failOrphans() { this.backend?.calls.failOrphans(); }
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
      try { await backend.controller.close(); }
      finally {
        backend.calls.close(); backend.unsubscribe();
        try { await backend.records.closeLogs(); }
        finally { activeStores.delete(backend.records.dir); releaseWriterLock(join(backend.records.dir, "lock")); }
      }
    })();
  }
}
