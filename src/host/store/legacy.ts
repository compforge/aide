import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ExecutionContextMeta } from "../execution-context.ts";

/** Read-only compatibility for execution journals written before resource contexts replaced Lanes. */
export function readExecutionContexts(meta: object): Record<string, ExecutionContextMeta> {
  const stored = meta as { contexts?: Record<string, ExecutionContextMeta>; lanes?: Record<string, { laneId: string; historyAfterSeq?: number; harnessSessions: ExecutionContextMeta["harnessSessions"] }> };
  if (stored.contexts) return stored.contexts;
  return Object.fromEntries(Object.entries(stored.lanes ?? {}).map(([id, lane]) => [id, {
    contextId: id, harnessSessions: lane.harnessSessions ?? {},
    ...(lane.historyAfterSeq === undefined ? {} : { historyAfterSeq: lane.historyAfterSeq }),
  }]));
}

/** Stable physical location of the pre-capability execution file; used only at storage boundaries. */
export function legacyExecutionDirectory(home: string): string {
  return join(home, "sessions", `~${createHash("sha256").update("aide:execution").digest("hex")}`);
}
