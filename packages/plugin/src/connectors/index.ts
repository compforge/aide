import type { RepositoryKey, RepositorySnapshot, PullRequestKey, PullRequestSnapshot } from "@compforge/harness-common";
export type { RepositoryKey, RepositorySnapshot, PullRequestKey, PullRequestSnapshot } from "@compforge/harness-common";
import type { EnvironmentDirectory, EnvironmentSummary } from "./environment.ts";
import type { Requirement, RequirementIdentity, RequirementListQuery, RequirementSummary, RequirementPage, RequirementAccount, RequirementComment, RequirementCommentQuery } from "./requirements.ts";
import type { ForgeComment, Page, PageQuery, PullRequestQuery, PullRequestReviewObservation, PullRequestScanQuery, PullRequestScanResult, PullRequestScanCursor, ForgeReadIssue } from "@compforge/repocli";
import type { MessageConnector } from "./messages.ts";

export type * from "./environment.ts";
export type * from "./requirements.ts";
export type { ForgeComment, Page, PageQuery, PullRequestQuery, PullRequestReviewObservation, PullRequestScanQuery, PullRequestScanResult, PullRequestScanCursor, ForgeReadIssue } from "@compforge/repocli";
export type * from "./messages.ts";

export interface ConnectorCatalog {
  readonly environments: readonly EnvironmentSummary[];
  readonly requirements: readonly { source: string; provider: string }[];
  readonly forges: readonly { forge: string; provider: string }[];
  readonly messages?: { provider: "lark"; accountId: string; userId: string };
}

/** Host-owned read capabilities, shared by all plugins. No credentials cross this boundary. */
export interface ConnectorClient {
  describe(): Promise<ConnectorCatalog>;
  readonly messages: MessageConnector;
  readonly environments: EnvironmentDirectory;
  readonly requirements: {
    list(source: string, query?: RequirementListQuery): Promise<RequirementPage<RequirementSummary>>;
    get(identity: RequirementIdentity): Promise<Requirement>;
    identity(source: string): Promise<RequirementAccount>;
    comments(identity: RequirementIdentity, query?: RequirementCommentQuery): Promise<RequirementPage<RequirementComment>>;
  };
  readonly forges: {
    listRepositories(forge: string, query?: PageQuery): Promise<Page<RepositorySnapshot>>;
    scanPullRequests(forge: string, query: PullRequestScanQuery): Promise<PullRequestScanResult>;
    listPullRequests(forge: string, query: PullRequestQuery): Promise<Page<PullRequestKey>>;
    getPullRequest(key: PullRequestKey): Promise<PullRequestSnapshot>;
    getPullRequestReview(key: PullRequestKey): Promise<PullRequestReviewObservation>;
    listPullRequestComments(key: PullRequestKey): Promise<readonly ForgeComment[]>;
  };
}
