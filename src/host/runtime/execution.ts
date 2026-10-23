import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { InvocationExecutor, type InvocationExecutorOptions } from "../controller/index.ts";
import type { ApprovalResult } from "../approval/types.ts";
import { HarnessActivity, RECENT_INVOCATIONS } from "../harness/activity.ts";
import { emptyHarnessState, type HarnessState } from "../harness/state.ts";
import type { ScheduledHarnessInvocation } from "../harness/invocation.ts";
import { HarnessCalls, type HarnessExecution, type HarnessRequest } from "../harness/calls.ts";
import type { ExecutionScope } from "../../protocol/verbs.ts";
import { acquireWriterLock, releaseWriterLock } from "../store/lease.ts";
import { logError } from "../logging.ts";
import { validateHarness, isHarnessInvocation } from "../../plugin-context.ts";

export type ExecutionOptions = Omit<InvocationExecutorOptions, "records">;
type Configuration = { id: string; harness: string; model?: string; effort?: string };
const activeExecutors = new Set<string>();

/**
 * @spec Aide coordinates live calls and approvals; only native Harness sessions recover agent state.
 * @why Operators supply recovery parameters; this service never accesses their resources. Progress is transient.
 * @link docs/kernel.md
 */
export class ExecutionService implements HarnessExecution {
  private backend?: { records: HarnessActivity; controller: InvocationExecutor; calls: HarnessCalls; unsubscribe: () => void };
  private closing?: Promise<void>;
  private readonly usingRuntimes = new Map<string, number>();
  private readonly idleRuntimes = new Set<string>();
  private readonly retiringRuntimes = new Map<string, Promise<void>>();
  private readonly listeners = new Set<() => void>();
  private readonly harnesses = new Map<string, Configuration>();
  constructor(private readonly home: string, private readonly options: ExecutionOptions & {
    cwd: string; harnesses?: readonly Configuration[]; defaultHarness?: string;
  }) {
    for (const target of options.harnesses ?? []) this.harnesses.set(target.id, { ...target });
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
      records = new HarnessActivity(dir, resolve(this.options.cwd));
      const controller = new InvocationExecutor({ ...this.options, records });
      const calls = new HarnessCalls({ records,
        harnesses: () => [...this.harnesses.values()],
        defaultHarness: this.options.defaultHarness,
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
  async invoke(scope: ExecutionScope, request: HarnessRequest): Promise<import("@compforge/aide-plugin").HarnessResult | import("@compforge/aide-plugin").HarnessOperationResult> {
    validateHarness(request.input);
    const running = this.performInvocation(scope, request);
    if (isHarnessInvocation(request.input)) return running;
    // A timed-out operation may already have been accepted. Its eventual effects are not replayed.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([running, new Promise<{ state: "timeout" }>(resolve => {
        timer = setTimeout(() => resolve({ state: "timeout" }), request.input.timeoutMs);
      })]);
    } finally { if (timer) clearTimeout(timer); }
  }
  private async performInvocation(scope: ExecutionScope, request: HarnessRequest) {
    const backend = this.open();
    const operation = request.input;
    if (operation.operation === "followUp" || operation.operation === "steer" || operation.operation === "abort") {
      const invocation = backend.calls.listHarnessInvocations().find(i => i.invocationId === operation.invocationId);
      if (!invocation || invocation.pluginInstanceId !== scope.pluginInstanceId || invocation.resourceRef?.uid !== scope.resourceRef?.uid || !scope.resourceRef?.uid || !invocation.runtimeId) {
        throw new Error("Harness input must target an invocation owned by the calling resource");
      }
      if (operation.harness && operation.harness !== invocation.harnessName) throw new Error("Harness selection does not match its invocation");
      if (operation.operation === "abort") {
        return { state: "success" as const, value: { outcome: backend.calls.cancelHarnessInvocation(operation.invocationId) ? "accepted" as const : "rejected" as const } };
      }
      return { state: "success" as const, value: await backend.controller.operate(invocation.runtimeId, invocation.harnessName, operation) };
    }
    const name = request.input.harness ?? this.options.defaultHarness;
    const configuration = name ? this.harnesses.get(name) : undefined;
    if (!configuration) throw new Error(`Unknown Harness configuration: ${name}`);
    const runtime = operation.operation === "close"
      ? backend.controller.findRuntime(configuration.id, scope, operation.session.id)
      : backend.controller.prepare(configuration.id, scope, "session" in operation ? operation.session : undefined);
    if (!runtime) return { state: "success" as const, value: { outcome: "accepted" as const } };
    const runtimeId = runtime.runtimeId;
    const reference = () => ({ harness: configuration.id, ...(runtime.session ? { session: structuredClone(runtime.session) } : {}) });
    this.usingRuntimes.set(runtimeId, (this.usingRuntimes.get(runtimeId) ?? 0) + 1);
    this.idleRuntimes.delete(runtimeId);
    try {
      await this.retiringRuntimes.get(runtimeId);
      let result;
      if (!isHarnessInvocation(operation)) {
        result = { state: "success" as const, value: await backend.controller.operate(runtimeId, configuration.id, operation) };
      } else result = await backend.calls.invoke(scope, request, runtimeId);
      return { ...result, agent: reference() };
    } catch (error) {
      return { state: "failure" as const, error: error instanceof Error ? error.message : String(error), agent: reference() };
    } finally {
      const remaining = this.usingRuntimes.get(runtimeId)! - 1;
      if (remaining) this.usingRuntimes.set(runtimeId, remaining);
      else {
        this.usingRuntimes.delete(runtimeId);
        this.idleRuntimes.add(runtimeId);
        await this.trimIdleRuntimes();
      }
    }
  }
  private async trimIdleRuntimes(): Promise<void> {
    const backend = this.backend!;
    const closing: Promise<void>[] = [];
    for (const runtimeId of this.idleRuntimes) {
      if (this.idleRuntimes.size <= RECENT_INVOCATIONS) break;
      this.idleRuntimes.delete(runtimeId);
      const retirement = (async () => {
        if (!await backend.controller.releaseRuntime(runtimeId)) return;
        for (const key of backend.records.projection.perContextTarget.keys()) {
          if (key.startsWith(`${runtimeId}\0`)) backend.records.projection.perContextTarget.delete(key);
        }
      })().finally(() => this.retiringRuntimes.delete(runtimeId));
      this.retiringRuntimes.set(runtimeId, retirement);
      closing.push(retirement);
    }
    await Promise.all(closing);
  }
  listHarnessInvocations() { return this.backend?.calls.listHarnessInvocations() ?? []; }
  cancelHarnessInvocation(id?: string) { return this.backend?.calls.cancelHarnessInvocation(id) ?? false; }
  failExecution(id: string, error: string) { this.backend?.calls.failExecution(id, error); }
  private enqueue(request: ScheduledHarnessInvocation) {
    const { controller } = this.open();
    return controller.enqueueHarnessInvocation({
      pluginInstanceId: request.pluginInstanceId,
      harnessName: request.harnessName, runtimeId: request.runtimeId,
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
      try { await Promise.all(this.retiringRuntimes.values()); await backend.controller.close(); }
      finally {
        backend.calls.close(); backend.unsubscribe();
        try { await backend.records.closeLogs(); }
        finally { activeExecutors.delete(backend.records.dir); releaseWriterLock(join(backend.records.dir, "execution.lock")); }
      }
    })();
  }
}
