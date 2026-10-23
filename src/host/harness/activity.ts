import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { logError, RuntimeLogger, type LogEntry } from "../logging.ts";
import { newId } from "../event/ids.ts";
import { ENVELOPE_VERSION, textOf, type AnyEventEnvelope, type EventEnvelope, type EventKind,
  type NewEvent, type InvocationSummary, type UsageUpdate } from "../event/index.ts";
import { applyEvent, emptyHarnessState } from "./state.ts";
import { invocationUserText } from "../store/message-relations.ts";

export const RECENT_INVOCATIONS = 40;
interface InvocationActivity { startedAt: string; endedAt: string; harness?: string; harnessName?: string; runtimeId?: string; usage?: UsageUpdate }
/**
 * @spec Live execution and UI state only. No event journal, replay, native history or recovery checkpoint.
 * @spec This observer holds no native session directory or recovery state.
 * @link docs/harness/README.md
 */
export class HarnessActivity {
  readonly logger: RuntimeLogger;
  readonly projection = emptyHarnessState();
  private readonly listeners = new Set<(event: AnyEventEnvelope) => void>();
  private readonly invocations = new Map<string, InvocationActivity>();
  private readonly summaries = new Map<string, EventEnvelope<"_aide_invocation_summary">>();
  private readonly recent: string[] = [];
  private nextSeq = 1;
  constructor(readonly dir: string, readonly cwd: string) {
    mkdirSync(dir, { recursive: true });
    this.logger = new RuntimeLogger(join(dir, "harness-runtime.log"), "harness");
  }
  subscribe(listener: (event: AnyEventEnvelope) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  appendEvent<K extends EventKind>(event: NewEvent<K>): EventEnvelope<K> {
    const harnessName = event.harnessName ?? (event.source.type === "harness" ? event.source.harnessName : undefined);
    const envelope = { v: ENVELOPE_VERSION, eventId: newId("ev"), ts: new Date().toISOString(), seq: this.nextSeq++,
      scope: { type: "application" }, ...event, ...(harnessName ? { harnessName } : {}) } as EventEnvelope<K>;
    if (envelope.invocationId) {
      const current = this.invocations.get(envelope.invocationId) ?? { startedAt: envelope.ts, endedAt: envelope.ts };
      current.endedAt = envelope.ts;
      current.harness ??= envelope.harness;
      current.harnessName ??= envelope.harnessName;
      current.runtimeId ??= envelope.runtimeId;
      if (envelope.kind === "usage_update") {
        const usage = (envelope as EventEnvelope<"usage_update">).payload;
        current.usage = { inputTokens: (current.usage?.inputTokens ?? 0) + (usage.inputTokens ?? 0),
          outputTokens: (current.usage?.outputTokens ?? 0) + (usage.outputTokens ?? 0),
          cacheReadTokens: (current.usage?.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0),
          cacheWriteTokens: (current.usage?.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          reasoningTokens: (current.usage?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
          isEstimated: current.usage?.isEstimated || usage.isEstimated };
      }
      this.invocations.set(envelope.invocationId, current);
    }
    applyEvent(this.projection, envelope as AnyEventEnvelope);
    for (const listener of this.listeners) {
      try { listener(envelope as AnyEventEnvelope); }
      catch (error) { this.log({ level: "error", source: "aide", component: "harness.activity", message: "Execution observer failed",
        error: logError(error), attributes: { seq: envelope.seq, kind: envelope.kind } }); }
    }
    return envelope;
  }
  log(entry: LogEntry) { this.logger.log(entry); }
  flushLogs() { return this.logger.flush(); }
  closeLogs() { return this.logger.close(); }
  summarizeInvocation(id: string): InvocationSummary { return this.summarizeInvocationEvent(id).payload; }
  summarizeInvocationEvent(id: string): EventEnvelope<"_aide_invocation_summary"> {
    const previous = this.summaries.get(id);
    if (previous) return previous;
    const invocation = this.invocations.get(id);
    if (!invocation) throw new Error(`No live activity for invocation ${id}`);
    const state = this.projection;
    const text = (final = false) => state.timeline.flatMap(item => {
      const message = item.type === "message" ? state.messages.get(item.id) : undefined;
      return message?.role === "agent" && message.invocationId === id && (!final || message.phase === "final") ? [textOf(message.content)] : [];
    }).filter(Boolean).join("\n") || undefined;
    const summary: InvocationSummary = { invocationId: id, stopReason: state.stopReasons.get(id),
      userText: invocationUserText(state, id) || undefined, agentText: text(), finalText: text(true),
      toolCalls: [...state.toolCalls.values()].filter(t => t.invocationId === id).map(t => ({ toolCallId: t.toolCallId, title: t.title, kind: t.kind, status: t.status })),
      usage: invocation.usage, startedAt: invocation.startedAt, endedAt: invocation.endedAt };
    const event = this.appendEvent({ kind: "_aide_invocation_summary", source: { type: "aide" }, payload: summary,
      invocationId: id, harness: invocation.harness, harnessName: invocation.harnessName, runtimeId: invocation.runtimeId });
    this.summaries.set(id, event);
    return event;
  }
  /** Release completed activity by count; active calls and approvals remain live. */
  release(id: string) {
    if (!this.recent.includes(id)) this.recent.push(id);
    while (this.recent.length > RECENT_INVOCATIONS) this.forget(this.recent.shift()!);
  }
  private forget(id: string) {
    const state = this.projection;
    this.invocations.delete(id); this.summaries.delete(id); state.stopReasons.delete(id); state.harnessInvocations.delete(id);
    state.invocationSummaries = state.invocationSummaries.filter(s => s.invocationId !== id);
    const removed = new Set<string>();
    for (const map of [state.messages, state.toolCalls, state.harnessInputs, state.tasks, state.proposedPlans, state.inputResponses, state.plans, state.approvalReviews, state.errors] as Map<string, { invocationId?: string }>[]) {
      for (const [key, item] of map) if (item.invocationId === id) { map.delete(key); removed.add(key); }
    }
    for (const [key, approval] of state.approvals) {
      if (approval.request.invocationId === id && approval.request.status !== "pending") {
        state.approvals.delete(key); removed.add(key);
      }
    }
    state.notices = state.notices.filter(notice => {
      if (notice.invocationId !== id) return true;
      removed.add(`n_${notice.seq}`); return false;
    });
    state.timeline = state.timeline.filter(item => !removed.has(item.id) && !(item.type === "harness_invocation" && item.id === id));
  }
  nativeEvent(
    harnessName: string,
    harness: string,
    event: { direction: "in"; name?: string; payload: unknown },
    runtimeId?: string,
  ): void {
    try {
      const path = join(this.dir, "harness-native.jsonl");
      if (existsSync(path) && statSync(path).size >= 10 * 1024 * 1024) {
        renameSync(path, `${path}.1`);
        chmodSync(`${path}.1`, 0o600);
      }
      appendFileSync(
        path,
        `${JSON.stringify({
          ts: new Date().toISOString(),
          harnessName,
          ...(runtimeId ? { runtimeId } : {}),
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

}
