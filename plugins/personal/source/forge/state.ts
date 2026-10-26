import type { PullRequestObservation, PullRequestKey, PullRequestCursor, PullRequestReadResult } from "@compforge/aide-plugin";
import { digest } from "../../chief-model.ts";
import type { SourceInput } from "../input.ts";

export interface Tracked { snapshot: PullRequestObservation; fingerprint: string; terminalAt?: string }
// Historical Source checkpoints are read only during migration; new progress belongs to repocli.
interface Scan { query: { updatedAfter?: string }; page?: { items: readonly PullRequestKey[] }; offset: number }
export interface ForgeSourceStatus {
  cursor?: PullRequestCursor;
  batch?: { result: PullRequestReadResult; offset: number } | null;
  readPending?: boolean;
  since?: string;
  seed?: readonly PullRequestKey[] | null;
  initialized?: boolean; sequence?: number; tracked?: Record<string, Tracked>;
  scan?: Scan | null; scannedThrough?: string;
  pending?: { name: string; key: string; spec: SourceInput; entry: Tracked } | null;
  refreshAfter?: string | null; refreshedAt?: string; lastObservedAt?: string; error?: string | null;
}

// Keep Topic and checkpoint keys stable independently of the shared object's wire representation.
export const keyOf = (pr: PullRequestKey) => JSON.stringify([pr.repository.forge.name, pr.repository.path, pr.number]);

/** Polling timestamps, target branch movement and diagnostic wording are not authored changes. */
export function fingerprint(pr: PullRequestObservation): string {
  return digest([keyOf(pr), pr.title, pr.url, pr.state, pr.headSha, pr.mergedAt,
    pr.reviewThreads, pr.reviewActivityKey, pr.conflictState, pr.mergeReadiness]);
}

type LegacyReference = { forge: string; path: string; number: number };
type LegacyObservation = Omit<PullRequestObservation, "repository" | "number" | "state"> & {
  identity: LegacyReference; lifecycle: PullRequestObservation["state"];
};
function reference(value: PullRequestKey | LegacyReference): PullRequestKey {
  return "repository" in value ? value : { repository: { forge: { name: value.forge }, path: value.path }, number: value.number };
}

/**
 * @spec Upgrade stored identity/lifecycle checkpoints without changing Topic keys, occurrence sequence or frozen pending Input plans.
 * @why Rebuilding a baseline by discovery would lose unlisted merged PRs and could duplicate already-admitted changes.
 * @see {@link component://docs/connector/forge.md}
 */
export function upgradeCheckpoint(status: ForgeSourceStatus): Partial<ForgeSourceStatus> | undefined {
  let changed = false;
  const entry = (value: Tracked): Tracked => {
    let snapshot = value.snapshot;
    if ("identity" in snapshot) {
      const { identity, lifecycle, ...facts } = snapshot as unknown as LegacyObservation;
      snapshot = { ...facts, ...reference(identity), state: lifecycle };
    }
    if ("mergeability" in snapshot) {
      const { mergeability, ...facts } = snapshot as PullRequestObservation & { mergeability: string };
      snapshot = { ...facts, conflictState: mergeability === "ready" ? "none" : mergeability === "conflicted" ? "conflicted" : "unknown",
        mergeReadiness: mergeability === "conflicted" ? "conflict" : "unknown" };
    }
    if (snapshot === value.snapshot) return value;
    changed = true;
    return { ...value, snapshot, fingerprint: fingerprint(snapshot) };
  };
  const patch: Partial<ForgeSourceStatus> = {};
  if (status.tracked) patch.tracked = Object.fromEntries(Object.entries(status.tracked).map(([key, value]) => [key, entry(value)]));
  if (status.pending) patch.pending = { ...status.pending, entry: entry(status.pending.entry) };
  if (!status.cursor && !status.batch && (status.scan || (status.scannedThrough && !status.since))) {
    // Restart the old unfinished window safely; page offsets cannot establish coverage.
    const dates = [status.since, status.scannedThrough, status.scan?.query.updatedAfter].filter((v): v is string => Boolean(v));
    if (dates.length) patch.since = dates.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
    patch.seed = [...(status.seed ?? []), ...(status.scan?.page?.items ?? []).map(reference)];
    patch.scan = null;
    changed = true;
  }
  return changed ? patch : undefined;
}
