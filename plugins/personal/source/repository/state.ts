import type { ForgeReadIssue, RepositorySnapshot } from "@compforge/aide-plugin";
import type { SourceSnapshot } from "../snapshot.ts";

export interface RepositorySourceStatus {
  snapshot?: SourceSnapshot<readonly RepositorySnapshot[]>;
  refresh?: { startedAt: string; cursor?: string; items: readonly RepositorySnapshot[] } | null;
  /** Complete inventory awaiting idempotent child creation. */
  handoff?: { offset: number; policyKey: string } | null;
  retryAt?: string | null;
  issues?: readonly ForgeReadIssue[];
  error?: string | null;
  retiredAt?: string | null;
}
