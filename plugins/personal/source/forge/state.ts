import type { PullRequestObservation, PullRequestKey, PullRequestDiscoveryQuery, PullRequestPage } from "@compforge/aide-plugin";
import { digest } from "../../chief-model.ts";
import type { SourceInput } from "../input.ts";

export interface Tracked { snapshot: PullRequestObservation; fingerprint: string; terminalAt?: string }
interface Scan { query: PullRequestDiscoveryQuery; page?: PullRequestPage; offset: number }
export interface ForgeSourceStatus {
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
    pr.reviewThreads, pr.reviewActivityKey, pr.mergeability]);
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
    if (!("identity" in value.snapshot)) return value;
    const { identity, lifecycle, ...facts } = value.snapshot as unknown as LegacyObservation;
    const snapshot = { ...facts, ...reference(identity), state: lifecycle };
    changed = true;
    return { ...value, snapshot, fingerprint: fingerprint(snapshot) };
  };
  const patch: Partial<ForgeSourceStatus> = {};
  if (status.tracked) patch.tracked = Object.fromEntries(Object.entries(status.tracked).map(([key, value]) => [key, entry(value)]));
  if (status.pending) patch.pending = { ...status.pending, entry: entry(status.pending.entry) };
  if (status.scan?.page) {
    const items = status.scan.page.items.map(value => {
      if (!("repository" in value)) changed = true;
      return reference(value);
    });
    patch.scan = { ...status.scan, page: { ...status.scan.page, items } };
  }
  return changed ? patch : undefined;
}
