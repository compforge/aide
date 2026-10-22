import { createHash } from "node:crypto";
import type { AnyEventDraft } from "../event/index.ts";
export interface HarnessHistoryBoundary {
  /** digest 语义版本；算法或归一投影变化时递增，禁止拿不同版本直接比较。 */
  version: 1;
  turnId?: string;
  turnCount: number;
  prefixDigest: string;
}

export interface HarnessHistoryEvent {
  source: "user" | "aide" | "harness";
  event: AnyEventDraft;
}

export interface HarnessHistoryTurn {
  /** Harness 中该 turn 的稳定 id；旧 Provider 缺失时用快照内位置兼容。 */
  turnId?: string;
  userText?: string;
  agentText?: string;
  /** Harness 已归一的完整 turn；缺省时兼容只提供 user/assistant 文本的 provider。 */
  events?: HarnessHistoryEvent[];
}

function canonicalHistoryValue(value: unknown, key?: string): unknown {
  // Aide 和 Harness 各自签发的局部 ID、时间戳不属于历史语义；保留它们会让同一事实
  // 因承载坐标不同而误报 divergence。
  if (key && (/Id$/.test(key) || key === "ts" || key.endsWith("At"))) return undefined;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalHistoryValue(item));
  }
  if (!value || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>).sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const normalized = canonicalHistoryValue(entryValue, entryKey);
    if (normalized !== undefined) out[entryKey] = normalized;
  }
  return out;
}

function historyTurnProjection(turn: HarnessHistoryTurn): unknown {
  return {
    userText: comparableTurnText(turn.userText) || undefined,
    agentText: comparableTurnText(turn.agentText) || undefined,
    events: turn.events?.map(({ source, event }) => ({
      source,
      kind: event.kind,
      payload: canonicalHistoryValue(event.payload),
    })),
  };
}

export function harnessHistoryBoundary(
  turns: readonly HarnessHistoryTurn[],
  throughCount = turns.length,
): HarnessHistoryBoundary {
  const prefix = turns.slice(0, throughCount);
  return {
    version: 1,
    turnId: prefix.at(-1)?.turnId,
    turnCount: prefix.length,
    prefixDigest: createHash("sha256")
      .update(JSON.stringify(prefix.map(historyTurnProjection)))
      .digest("hex"),
  };
}

function comparableTurnText(text: string | undefined): string { return (text ?? "").replace(/\r\n/g, "\n").replace(/\n{2,}/g, "\n").trim(); }
