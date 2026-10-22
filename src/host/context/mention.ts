// @ 引用的急切解析：Mention 统一产生当前调用 的只读材料；
// 本文件保留 Session 摘要与旧 @bs_ token 的兼容展开。

import type { InvocationSummary } from "../event/index.ts";
import type { HarnessTarget } from "../harness/target.ts";
import {
  sessionDisplayTitle,
  type SessionHandle,
  type SessionStore,
} from "../store/store.ts";
import type { Mention } from "@compforge/aide-plugin";

/** @bs_<ULID>：Mention 上线前的 Session token，继续兼容已有输入。 */
const MENTION_PATTERN = /@(bs_[0-9A-HJKMNP-TV-Z]{26})/g;

// 摘要 token 预算的初值拍 4KB 字符（design 开放问题 #4），超限丢最旧的调用
export const DEFAULT_MENTION_BUDGET_CHARS = 4096;

export interface ParsedMention {
  aideSessionId: string;
}

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

export function parseMentions(text: string): ParsedMention[] {
  const seen = new Set<string>();
  const out: ParsedMention[] = [];
  for (const m of text.matchAll(MENTION_PATTERN)) {
    const id = m[1] as string;
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ aideSessionId: id });
    }
  }
  return out;
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

/**
 * 目标会话的紧凑摘要。数据源是 invocation-summary 事件（写入时已压缩，见 store.summarizeInvocation）。
 * 预算内优先保最近的调用：从最新往回装，装不下即停，再恢复时间序。
 */
export function buildSessionContext(
  store: SessionStore,
  aideSessionId: string,
  budgetChars: number = DEFAULT_MENTION_BUDGET_CHARS,
): string {
  const session = store.openSession(aideSessionId);
  const summaries = session.loadState().invocationSummaries;
  const title = sessionDisplayTitle(session.meta);
  const harnesses = session.meta.harnessTargets
    ? Object.keys(session.meta.harnessTargets).join(", ")
    : "unknown";
  const header = `# Session summary: ${title} (id: ${aideSessionId}, agent: ${harnesses})`;

  if (summaries.length === 0) {
    return `${header}\n(no completed invocations in this session yet)`;
  }

  const picked: string[] = [];
  let used = header.length;
  let dropped = 0;
  for (let i = summaries.length - 1; i >= 0; i--) {
    const block = invocationBlock(summaries[i] as InvocationSummary, i);
    if (used + block.length + 2 > budgetChars && picked.length > 0) {
      dropped = i + 1;
      break;
    }
    used += block.length + 2;
    picked.unshift(block);
    if (used > budgetChars) {
      // 单个 block 就超预算：硬截断保留尾部（最新内容在后）
      picked[0] = (picked[0] as string).slice(-(budgetChars - header.length));
      dropped = i;
      break;
    }
  }
  const parts = [header];
  if (dropped > 0) parts.push(`(${dropped} earlier invocations omitted for length)`);
  parts.push(...picked);
  return parts.join("\n\n");
}

function invocationSummaries(handle: SessionHandle): InvocationSummaryRecord[] {
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
  handle: SessionHandle,
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

/**
 * 展开输入里的所有 @ 引用：返回最终发给 agent 的文本。
 * 注入内容以"用户提供的只读参考材料"身份出现，归属清晰，不伪造对方记忆。
 */
export function expandMentions(
  store: SessionStore,
  text: string,
  budgetChars: number = DEFAULT_MENTION_BUDGET_CHARS,
): { prompt: string; mentions: ParsedMention[] } {
  const mentions = parseMentions(text);
  if (mentions.length === 0) return { prompt: text, mentions };
  const perMentionBudget = Math.floor(budgetChars / mentions.length);
  const contexts = mentions.map((m) => buildSessionContext(store, m.aideSessionId, perMentionBudget));
  const prompt = [
    "<aide-context>",
    "Summaries of other agent sessions referenced by the user, provided as background context only:",
    ...contexts,
    "</aide-context>",
    "",
    text,
  ].join("\n\n");
  return { prompt, mentions };
}

/** Built-in explicit context; Plugin providers use the same registration path. */
export function sessionMention(
  store: SessionStore,
  options: {
    readonly excludeSessionId?: string;
  } = {},
): Mention {
  return {
    namespace: "session",
    async search(query) {
      const normalized = query.toLowerCase();
      return store
        .listSessions()
        .filter((session) =>
          session.aideSessionId !== options.excludeSessionId
        )
        .filter((session) =>
          session.aideSessionId.toLowerCase().startsWith(normalized) ||
          (
            normalized !== "" &&
            sessionDisplayTitle(session).toLowerCase().includes(normalized)
          )
        )
        .map((session) => ({
          id: session.aideSessionId,
          label: `@${session.aideSessionId.slice(0, 12)}…`,
          description: sessionDisplayTitle(session),
        }));
    },
    async resolve(id, { maxChars }) {
      if (id === options.excludeSessionId) return undefined;
      return buildSessionContext(store, id, maxChars);
    },
  };
}
