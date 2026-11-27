import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";

/** @spec One optional compaction before the first prompt after dormancy. Pi keeps its recent tail.
 * @why A maintenance failure must leave the upcoming business delivery available in the original session.
 * @link docs/personal/secretary.md#领域静默
 */
export async function compactOnWake(session: Pick<AgentSession, "sessionId" | "getContextUsage" | "compact">, threshold: number, log: Pick<Logger, "info" | "warn">) {
  try {
    const tokens = session.getContextUsage()?.tokens;
    if (tokens == null || tokens < threshold) return;
    const result = await session.compact("Preserve open questions, decisions and the relevant Input, Work and Note IDs so Chief can reread original evidence.");
    log.info({ sessionId: session.sessionId, tokensBefore: result.tokensBefore, tokensAfter: result.estimatedTokensAfter }, "Chief wake compaction completed");
  } catch (error) {
    log.warn({ sessionId: session.sessionId, error: String(error) }, "Chief wake compaction skipped; continuing business delivery");
  }
}
