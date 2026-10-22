import { acquireWriterLock, releaseWriterLock } from "../store/lease.ts";
import { readExecutionContexts, legacyExecutionDirectory } from "../store/legacy.ts";
import { invocationUserText } from "../store/message-relations.ts";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type LogEntry, logError, RuntimeLogger, type RuntimeLoggerOptions } from "../logging.ts";
import { newId } from "../event/ids.ts";
import { ENVELOPE_VERSION, textOf, type AnyEventEnvelope, type EventEnvelope, type EventKind,
  type NewEvent, type StopReason, type InvocationSummary, type InvocationSummaryToolCall, type UsageUpdate } from "../event/index.ts";
import { EventLedger } from "../event/ledger.ts";
import type { HarnessSessionMeta, ExecutionContextMeta } from "../execution-context.ts";
import { applyEvent, reduceEvents, type HarnessState } from "../harness/state.ts";

export interface HarnessTargetMeta {
  harnessTargetId: string;
  harness: string;
  model?: string;
  effort?: string;
  mode?: string;
}

export interface HarnessMetadata {
  cwd: string;
  createdAt: string;
  updatedAt?: string;
  harnessTargets: Record<string, HarnessTargetMeta>;
  contexts: Record<string, ExecutionContextMeta>;
}
function normalizeMetadata(meta: HarnessMetadata): HarnessMetadata {
  return { cwd: meta.cwd, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
    harnessTargets: meta.harnessTargets ?? {}, contexts: readExecutionContexts(meta) };
}
/** Existing deployments keep their physical path; this is not a host Session identity. */
export function harnessStorageDirectory(home: string): string {
  return legacyExecutionDirectory(home);
}
export function openHarnessStore(home: string, cwd: string): HarnessStore {
  const dir = harnessStorageDirectory(home);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "meta.json");
  const meta = existsSync(path) ? normalizeMetadata(JSON.parse(readFileSync(path, "utf8")))
    : { cwd: resolve(cwd), createdAt: new Date().toISOString(), harnessTargets: {}, contexts: {} };
  return new HarnessStore(dir, meta);
}
function writeMetaAtomic(dir: string, meta: HarnessMetadata): void {
  const tmp = join(dir, "meta.json.tmp");
  writeFileSync(tmp, JSON.stringify(meta, null, 2));
  renameSync(tmp, join(dir, "meta.json"));
}
/**
 * @spec Persists Harness execution facts and resource-owned native bindings; it owns no plugin resources.
 * @why Event replay reconstructs execution state, never resumes a Reconcile call stack.
 * @link docs/kernel.md
 */
export class HarnessStore {
  readonly dir: string;
  readonly logger: RuntimeLogger;
  readonly ledger: EventLedger;
  private readonly eventListeners = new Set<(event: AnyEventEnvelope) => void>();
  private state: HarnessState;
  private nextEventSeq: number;
  meta: HarnessMetadata;

  constructor(
    dir: string,
    meta: HarnessMetadata,
    loggerOptions: RuntimeLoggerOptions = {},
  ) {
    this.dir = dir;
    this.meta = normalizeMetadata(meta);
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, "meta.json"))) writeMetaAtomic(dir, this.meta);
    this.logger = new RuntimeLogger(
      join(this.dir, "session.log"),
      "harness",
      loggerOptions,
    );
    this.ledger = new EventLedger({
      path: join(this.dir, "session.jsonl"),
      log: (entry) => this.log(entry),
    });
    const history = this.ledger.read();
    this.state = reduceEvents(history);
    this.nextEventSeq = (history.at(-1)?.seq ?? 0) + 1;
  }

  /** Current Core projection. Live events and replay both use the same reducer. */
  get projection(): HarnessState {
    return this.state;
  }

  /** Observe committed execution events after they have been recorded and reduced. */
  subscribe(listener: (event: AnyEventEnvelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /**
   * HarnessStore 的统一 Event 入口。当前策略先完成 WAL record，再直接 reduce；
   * Ledger 只是 Recorder，不承担实时分发。
   */
  appendEvent<K extends EventKind>(event: NewEvent<K>): EventEnvelope<K> {
    // Harness-originated facts already carry the exact Target identity in their
    // source. Preserve it as the execution coordinate when a direct/legacy
    // producer omitted the top-level field; never infer a Target from a Harness
    // family name. An explicit coordinate remains authoritative.
    const harnessTargetId =
      event.harnessTargetId ??
      (event.source.type === "harness"
        ? event.source.harnessTargetId
        : undefined);
    const envelope: EventEnvelope<K> = {
      v: ENVELOPE_VERSION,
      eventId: newId("ev"),
      ts: new Date().toISOString(),
      seq: this.nextEventSeq,
      scope: { type: "application" },
      ...event,
      ...(harnessTargetId === undefined ? {} : { harnessTargetId }),
    };
    this.ledger.record(envelope);
    this.nextEventSeq += 1;
    applyEvent(this.state, envelope as AnyEventEnvelope);
    for (const listener of this.eventListeners) {
      try {
        listener(envelope as AnyEventEnvelope);
      } catch (error) {
        this.log({
          level: "error",
          source: "aide",
          component: "harness.event",
          message: "HarnessStore event listener threw",
          error: logError(error),
          attributes: { seq: envelope.seq, kind: envelope.kind },
        });
      }
    }
    return envelope;
  }

  /**
   * Structured operational logs are deliberately separate from the event ledger:
   * they support diagnosis, not replay or product state.
   */
  log(entry: LogEntry): void {
    this.logger.log(entry);
  }

  async flushLogs(): Promise<void> {
    await this.logger.flush();
  }

  async closeLogs(): Promise<void> {
    await this.logger.close();
  }

  /**
   * Provider 原生入站消息的旁路 NDJSON。与 session.log 分开，避免高频 wire trace
   * 淹没错误诊断；单文件到 10 MiB 后保留一份上一代。失败不影响正典事件流。
   */
  nativeEvent(
    harnessTargetId: string,
    harness: string,
    event: { direction: "in"; name?: string; payload: unknown },
    contextId?: string,
  ): void {
    try {
      const safeTarget = harnessTargetId.replace(/[^a-zA-Z0-9._-]/g, "-");
      const safeContext = contextId?.replace(/[^a-zA-Z0-9._-]/g, "-");
      const path = join(
        this.dir,
        `native-${safeTarget}${safeContext ? `-${safeContext}` : ""}.jsonl`,
      );
      if (existsSync(path) && statSync(path).size >= 10 * 1024 * 1024) {
        renameSync(path, `${path}.1`);
        chmodSync(`${path}.1`, 0o600);
      }
      appendFileSync(
        path,
        `${JSON.stringify({
          ts: new Date().toISOString(),
          harnessTargetId,
          ...(contextId ? { contextId } : {}),
          harness,
          ...event,
        })}\n`,
        { encoding: "utf8", mode: 0o600 },
      );
      chmodSync(path, 0o600);
    } catch {
      // 原生 trace 只服务协议排障，不能反向影响 Harness 执行。
    }
  }

  private lockPath(): string {
    return join(this.dir, "lock");
  }

  /** @spec Acquire the writer lease before recovery; another live writer makes recovery unsafe. */
  acquireLock(): boolean {
    return acquireWriterLock(this.lockPath());
  }

  /** 只释放自己持有的锁；释放失败不阻塞退出（stale 锁由下次 acquire 的存活判定接管）。 */
  releaseLock(): void {
    releaseWriterLock(this.lockPath());
  }

  loadState(): HarnessState {
    return reduceEvents(this.ledger.read());
  }

  updateMeta(patch: Partial<HarnessMetadata>): void {
    this.meta = normalizeMetadata({ ...this.meta, ...patch });
    writeMetaAtomic(this.dir, this.meta);
  }

  setHarnessTarget(harnessTargetId: string, target: HarnessTargetMeta): void {
    if (target.harnessTargetId !== harnessTargetId) {
      throw new Error(
        `harness target key mismatch: key=${harnessTargetId}, meta=${target.harnessTargetId}`,
      );
    }
    this.meta.harnessTargets = {
      ...this.meta.harnessTargets,
      [harnessTargetId]: target,
    };
    this.meta = normalizeMetadata(this.meta);
    writeMetaAtomic(this.dir, this.meta);
  }

  setExecutionContext(contextId: string, context: ExecutionContextMeta): void {
    if (context.contextId !== contextId) {
      throw new Error(
        `context key mismatch: key=${contextId}, meta=${context.contextId}`,
      );
    }
    this.meta.contexts = { ...this.meta.contexts, [contextId]: context };
    this.meta = normalizeMetadata(this.meta);
    writeMetaAtomic(this.dir, this.meta);
  }

  setContextHarnessSession(
    contextId: string,
    harnessTargetId: string,
    harnessSession: HarnessSessionMeta,
  ): void {
    const context = this.meta.contexts[contextId];
    if (!context) throw new Error(`Execution context not found: ${contextId}`);
    this.setExecutionContext(contextId, {
      ...context,
      harnessSessions: {
        ...context.harnessSessions,
        [harnessTargetId]: harnessSession,
      },
    });
  }

  requireExecutionContext(contextId: string): ExecutionContextMeta {
    const context = this.meta.contexts[contextId];
    if (!context) throw new Error(`Execution context not found: ${contextId}`);
    return context;
  }

  /**
   * 汇总一次调用并落盘 _aide_invocation_summary 事件。
   * 幂等：同一 invocationId 已有 summary 时直接返回已有的，不重复追加。
   */
  summarizeInvocation(invocationId: string): InvocationSummary {
    return this.summarizeInvocationEvent(invocationId).payload;
  }

  /** 与 summarizeInvocation 相同，但返回 envelope，供 live reducer 消费实际落盘事件。 */
  summarizeInvocationEvent(invocationId: string): EventEnvelope<"_aide_invocation_summary"> {
    const events = this.ledger.read();
    const existing = events.find(
      (e): e is EventEnvelope<"_aide_invocation_summary"> =>
        e.kind === "_aide_invocation_summary" && e.payload.invocationId === invocationId,
    );
    if (existing) return existing;

    const invocationEvents = events.filter((e) => e.invocationId === invocationId);
    if (invocationEvents.length === 0) {
      throw new Error(`no events for invocation ${invocationId} in ${this.dir}`);
    }
    const state = reduceEvents(invocationEvents);

    // 自动注入块保留在原始事件里供审计，但不能进入摘要后再次被下一棒递归放大。
    // A native queue can consume a body recorded before admission. Resolve
    // messages from the execution projection, then select their actual ownership;
    // filtering the ledger first would discard the body or its consumption fact.
    const messages = this.loadState();
    const userText = invocationUserText(messages, invocationId);
    const agentText = invocationAgentText(messages, invocationId);
    const finalText = invocationAgentText(messages, invocationId, "final");
    const toolCalls: InvocationSummaryToolCall[] = [...state.toolCalls.values()].map((tc) => ({
      toolCallId: tc.toolCallId,
      title: tc.title,
      kind: tc.kind,
      status: tc.status,
    }));
    const usage: UsageUpdate | undefined =
      state.usage.inputTokens || state.usage.outputTokens
        ? {
            inputTokens: state.usage.inputTokens,
            outputTokens: state.usage.outputTokens,
            cacheReadTokens: state.usage.cacheReadTokens,
            cacheWriteTokens: state.usage.cacheWriteTokens,
            reasoningTokens: state.usage.reasoningTokens,
            isEstimated: state.usage.hasEstimated,
          }
        : undefined;

    const summary: InvocationSummary = {
      invocationId: invocationId,
      // Resolve the stop reason by invocation even when the projection contains other terminal events.
      stopReason: (state.stopReasons.get(invocationId) ?? state.lastStopReason) as StopReason | undefined,
      userText: userText || undefined,
      agentText: agentText || undefined,
      finalText: finalText || undefined,
      toolCalls,
      usage,
      startedAt: invocationEvents[0]?.ts,
      endedAt: invocationEvents[invocationEvents.length - 1]?.ts,
    };
    const harness = invocationEvents[0]?.harness ?? "aide";
    const harnessTargetId = invocationEvents.find((event) => event.harnessTargetId)?.harnessTargetId;
    const contextId = invocationEvents.find((event) => event.contextId)?.contextId;
    const event = this.appendEvent({
      kind: "_aide_invocation_summary",
      source: { type: "aide" },
      payload: summary,
      harness,
      ...(harnessTargetId ? { harnessTargetId } : {}),
      ...(contextId ? { contextId } : {}),
      invocationId: invocationId,
    }) as EventEnvelope<"_aide_invocation_summary">;
    this.updateMeta({ updatedAt: summary.endedAt ?? new Date().toISOString() });
    return event;
  }
}

function invocationAgentText(state: HarnessState, invocationId: string, phase?: "final"): string {
  const parts: string[] = [];
  for (const item of state.timeline) {
    if (item.type !== "message") continue;
    const msg = state.messages.get(item.id);
    if (msg && msg.role === "agent" && msg.invocationId === invocationId) {
      if (phase && msg.phase !== phase) continue;
      const text = textOf(msg.content);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

