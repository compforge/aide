import type { HarnessOptions } from "./configuration.ts";
import type {
  HarnessHistoryBoundary,
  HarnessHistoryTurn as StoredHarnessHistoryTurn
} from "../harness/history.ts";
import type { HarnessSessionIdentity } from "./adapter.ts";

export interface HarnessTranscriptEntry {
  role: "user" | "assistant";
  text: string;
}

export type HarnessHistoryTurn = StoredHarnessHistoryTurn;

export interface HarnessHistorySnapshot {
  /** HarnessConfiguration 内稳定的 HarnessSession identity。 */
  identity?: HarnessSessionIdentity;
  /** Inspector 观察到的完整前缀。 */
  observedThrough?: HarnessHistoryBoundary;
  cwd?: string;
  title?: string;
  /** 完整归一 Turn 优先；只提供文本历史的 Harness 可继续使用 transcript。 */
  turns?: HarnessHistoryTurn[];
  transcript?: HarnessTranscriptEntry[];
}

export interface HarnessSessionInspectorOptions {
  targetConfig: HarnessOptions;
  cwd: string;
}

/** Inspector 只读观察 HarnessSession；它不能启动、恢复或修改该会话。 */
export interface HarnessSessionInspector {
  inspect(
    sessionId: string,
    options: HarnessSessionInspectorOptions,
  ): Promise<HarnessHistorySnapshot | null>;
}

/** 把 Harness 文本历史还原成 Aide 的逻辑 turn；连续 assistant 消息属于同一轮回复。 */
export function harnessHistoryTurns(
  transcript: readonly HarnessTranscriptEntry[],
): HarnessHistoryTurn[] {
  const turns: HarnessHistoryTurn[] = [];
  for (const entry of transcript) {
    if (entry.role === "user") {
      turns.push({ userText: entry.text });
      continue;
    }
    const turn = turns.at(-1);
    if (!turn) {
      turns.push({ agentText: entry.text });
      continue;
    }
    turn.agentText = turn.agentText
      ? `${turn.agentText}\n\n${entry.text}`
      : entry.text;
  }
  return turns;
}
