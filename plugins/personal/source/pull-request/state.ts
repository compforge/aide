import type { PullRequestSnapshot, PullRequestKey, PullRequestScanCursor, PullRequestScanResult, ForgeReadIssue } from "@compforge/aide-plugin";
import { digest } from "../../chief-model.ts";
import type { SourceInput } from "../input.ts";
import type { SourceSnapshot } from "../snapshot.ts";

export interface Tracked { snapshot: PullRequestSnapshot; fingerprint: string; terminalAt?: string }
export interface PullRequestSourceStatus {
  snapshot?: SourceSnapshot<Record<string, Tracked>>;
  cursor?: PullRequestScanCursor;
  batch?: { inputSince: string; result: PullRequestScanResult; offset: number } | null;
  scanPending?: boolean;
  scanComplete?: boolean;
  issues?: readonly ForgeReadIssue[];
  initialSince?: string;
  inputSince?: string;
  sequence?: number;
  pending?: { name: string; key: string; spec: SourceInput; entry: Tracked } | null;
  lastObservedAt?: string;
  retiredAt?: string | null;
  error?: string | null;
}
export const keyOf = (pr: PullRequestKey) => JSON.stringify([pr.repository.forge.name, pr.repository.path, pr.number]);
export function fingerprint(pr: PullRequestSnapshot): string {
  return digest([keyOf(pr), pr.title, pr.url, pr.state, pr.headSha, pr.mergedAt, pr.conflictState, pr.mergeReadiness]);
}
export function nextPullRequestPollDelay(status: PullRequestSourceStatus, intervalMs: number): number {
  if (status.error) return intervalMs;
  const issues = status.issues ?? [];
  const retryAfterMs = Math.max(0, ...issues.map(issue => issue.retryAfterMs ?? 0));
  const pending = status.batch || status.pending || status.scanPending || !status.cursor;
  const wait = issues.some(issue => ["auth", "rate_limit", "transport", "coverage"].includes(issue.kind));
  return Math.max(retryAfterMs, pending && !wait ? 1000 : intervalMs);
}
