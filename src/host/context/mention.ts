import type { InvocationSummary } from "../event/index.ts";
import type { HarnessTarget } from "../harness/target.ts";
import type { HarnessStore } from "../harness/store.ts";
export const DEFAULT_MENTION_BUDGET_CHARS = 4096;
interface InvocationSummaryRecord {
  harnessTargetId: string;
  contextId?: string;
  seq: number;
  summary: InvocationSummary;
}

export interface HarnessCatchUpContext {
  text: string;
  throughSeq: number;
}

function invocationBlock(
  s: InvocationSummary,
  index: number,
  source?: Pick<InvocationSummaryRecord, "harnessTargetId">,
): string {
  const assistant = source ? `assistant[${source.harnessTargetId}]` : "agent";
  const tools = source ? `tools[${source.harnessTargetId}]` : "tools";
  const lines: string[] = source
    ? []
    : [`## Invocation ${index + 1}${s.stopReason ? ` (${s.stopReason})` : ""}`];
  if (s.userText) lines.push(`user: ${s.userText}`);
  if (s.agentText) lines.push(`${assistant}: ${s.agentText}`);
  if (s.toolCalls.length) {
    lines.push(`${tools}: ${s.toolCalls.map((t) => `${t.title ?? t.toolCallId} [${t.status ?? "?"}]`).join("; ")}`);
  }
  if (source && s.stopReason && s.stopReason !== "end_turn") {
    lines.push(`status: ${s.stopReason}`);
  }
  return lines.join("\n");
}

function invocationSummaries(handle: HarnessStore): InvocationSummaryRecord[] {
  const projected = new Map(handle.loadState().invocationSummaries.map((summary) => [summary.invocationId, summary]));
  return handle.ledger
    .read()
    .filter((event) => event.kind === "_aide_invocation_summary")
    .map((event) => {
      const summary = projected.get(event.payload.invocationId);
      return {
        harnessTargetId: event.harnessTargetId!, contextId: event.contextId,
        seq: summary?.updatedSeq ?? event.seq,
        summary: summary ?? event.payload,
      };
    })
    .sort((a, b) => a.seq - b.seq);
}

/**
 * @spec Restore only this resource context and Target's history into a fresh native session.
 * @why A shared execution journal is not shared agent context. Cross-resource knowledge
 * must be supplied explicitly by the plugin; a resumed native session already owns its history.
 * @link tests/execution-journal.test.ts
 */
export function buildTargetCatchUpContext(
  handle: HarnessStore,
  opts: {
    target: HarnessTarget;
    contextId: string;
    sinceSeq: number;
    restoreHistory: boolean;
    budgetChars?: number;
  },
): HarnessCatchUpContext | null {
  const summaries = invocationSummaries(handle);
  const historyAfterSeq = opts.contextId ? handle.meta.contexts[opts.contextId]?.historyAfterSeq ?? 0 : 0;
  // Resource contexts are isolated. Reconstruct only this binding's own history;
  // shared knowledge must arrive through explicit plugin context, never journal catch-up.
  const missed = summaries.filter(item => item.contextId === opts.contextId &&
    item.harnessTargetId === opts.target.id && opts.restoreHistory &&
    item.seq > Math.max(opts.sinceSeq, historyAfterSeq));
  if (missed.length === 0) return null;

  const header = "# Execution context history (auto-restored by aide)";
  const budgetChars = opts.budgetChars ?? DEFAULT_MENTION_BUDGET_CHARS;
  const picked: string[] = [];
  let used = header.length;
  let dropped = 0;
  for (let i = missed.length - 1; i >= 0; i--) {
    const m = missed[i] as (typeof missed)[number];
    const block = invocationBlock(m.summary, i, m);
    if (used + block.length + 2 > budgetChars && picked.length > 0) {
      dropped = i + 1;
      break;
    }
    used += block.length + 2;
    picked.unshift(block);
  }
  const parts = [header];
  if (dropped > 0) parts.push(`(${dropped} earlier invocations omitted for length)`);
  parts.push(...picked);
  return {
    text: parts.join("\n\n"),
    throughSeq: missed.at(-1)!.seq,
  };
}
