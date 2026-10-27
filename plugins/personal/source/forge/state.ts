import type { PullRequestSnapshot, PullRequestKey, PullRequestScanCursor, PullRequestScanResult, ForgeReadIssue } from "@compforge/aide-plugin";
import { digest } from "../../chief-model.ts";
import type { SourceInput } from "../input.ts";

export interface Tracked { snapshot: PullRequestSnapshot; fingerprint: string; terminalAt?: string }
interface FrozenBatch { inputSince: string; result: Omit<PullRequestScanResult, "cursor"> & { cursor?: PullRequestScanCursor }; offset: number }
export interface ForgeSourceStatus {
  schemaVersion?: 2;
  cursor?: PullRequestScanCursor | null;
  batch?: FrozenBatch | null;
  scanPending?: boolean;
  scanComplete?: boolean;
  issues?: readonly ForgeReadIssue[];
  initialSince?: string;
  /** Old unseen terminal facts outside this retention horizon establish a baseline, not another Input. */
  inputSince?: string;
  seed?: readonly PullRequestKey[] | null;
  sequence?: number;
  tracked?: Record<string, Tracked>;
  pending?: { name: string; key: string; spec: SourceInput; entry: Tracked } | null;
  lastObservedAt?: string;
  error?: string | null;
  // Read-only legacy fields. Migration clears these without inspecting repocli's opaque cursor.
  readPending?: boolean | null;
  since?: string | null;
  initialized?: boolean;
  scan?: { query: { updatedAfter?: string }; page?: { items: readonly PullRequestKey[] }; offset: number } | null;
  scannedThrough?: string | null;
  refreshAfter?: string | null;
  refreshedAt?: string | null;
}

// Topic and checkpoint identity stays stable across shared model and source schema changes.
export const keyOf = (pr: PullRequestKey) => JSON.stringify([pr.repository.forge.name, pr.repository.path, pr.number]);
export function fingerprint(pr: PullRequestSnapshot): string {
  return digest([keyOf(pr), pr.title, pr.url, pr.state, pr.headSha, pr.mergedAt, pr.conflictState, pr.mergeReadiness]);
}

type LegacyReference = { forge: string; path: string; number: number };
function reference(value: PullRequestKey | LegacyReference): PullRequestKey {
  return "repository" in value ? value : { repository: { forge: { name: value.forge }, path: value.path }, number: value.number };
}
function snapshot(value: PullRequestSnapshot): PullRequestSnapshot {
  const { identity, lifecycle, mergeability, reviewThreads: _threads, reviewActivityKey: _activity,
    reviewError: _error, observedAt: _observedAt, ...facts } = value as PullRequestSnapshot & {
      identity?: LegacyReference; lifecycle?: PullRequestSnapshot["state"]; mergeability?: string;
      reviewThreads?: unknown; reviewActivityKey?: unknown; reviewError?: unknown; observedAt?: string;
    };
  return { ...facts, ...(identity ? { ...reference(identity), state: lifecycle } : {}),
    ...(mergeability ? { conflictState: mergeability === "ready" ? "none" as const : mergeability === "conflicted" ? "conflicted" as const : "unknown" as const,
      mergeReadiness: mergeability === "conflicted" ? "conflict" as const : "unknown" as const } : {}) };
}

/**
 * @spec Preserve frozen Input ids/bodies, consumed batch offsets and business baselines; old reader cursors are never interpreted or reused.
 * @why Restarting discovery cannot replace durable admission, and an expired baseline must not turn historical merges into new events.
 * @link docs/connector/forge.md
 * @case tests/forge-source.test.ts
 */
export function upgradeCheckpoint(status: ForgeSourceStatus, now: string, lookbackMs: number): Partial<ForgeSourceStatus> | undefined {
  if (status.schemaVersion === 2) return;
  const entry = (value: Tracked): Tracked => {
    const current = snapshot(value.snapshot);
    return { ...value, snapshot: current, fingerprint: fingerprint(current) };
  };
  const cutoff = new Date(Date.parse(now) - lookbackMs).toISOString();
  const starts = [status.since, status.scannedThrough, status.scan?.query.updatedAfter, cutoff]
    .filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)));
  const batch = status.batch;
  return { schemaVersion: 2, cursor: null, scanPending: false, scanComplete: false, issues: [],
    initialSince: starts.sort((a, b) => Date.parse(a) - Date.parse(b))[0], inputSince: cutoff,
    tracked: Object.fromEntries(Object.entries(status.tracked ?? {}).map(([key, value]) => [key, entry(value)])),
    ...(status.pending ? { pending: { ...status.pending, entry: entry(status.pending.entry) } } : {}),
    // Drain already frozen facts at their original offset, but never commit a v1 reader cursor.
    batch: batch ? { inputSince: cutoff, offset: batch.offset, result: { items: batch.result.items.map(snapshot), pending: false, complete: false, issues: [] } } : null,
    seed: [...new Map([...(status.seed ?? []), ...(status.scan?.page?.items ?? [])].map(value => { const key = reference(value); return [keyOf(key), key] as const; })).values()],
    since: null, scan: null, scannedThrough: null, readPending: null, refreshAfter: null, refreshedAt: null,
  };
}

/** Local admission failures back off; a missing object does not delay healthy work in the same scan. */
export function nextForgePollDelay(status: ForgeSourceStatus, intervalMs: number): number {
  if (status.error) return intervalMs;
  const issues = status.issues ?? [];
  const retryAfterMs = Math.max(0, ...issues.map(issue => issue.retryAfterMs ?? 0));
  const pending = status.batch || status.pending || status.scanPending || !status.cursor;
  const wait = issues.some(issue => ["auth", "rate_limit", "transport", "coverage"].includes(issue.kind));
  return Math.max(retryAfterMs, pending && !wait ? 1000 : intervalMs);
}
