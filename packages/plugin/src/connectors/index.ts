import type { ConnectorAccess } from "@compforge/aide-connector";
import type { RepositorySnapshot, PullRequestKey, PullRequestSnapshot, ForgeComment, Page, PageQuery, PullRequestQuery, PullRequestReviewObservation, PullRequestScanQuery, PullRequestScanResult } from "@compforge/aide-connector/forge";
import type { EnvironmentDirectory, EnvironmentSummary } from "@compforge/aide-connector/environment";
import type { Requirement, RequirementIdentity, RequirementListQuery, RequirementSummary, RequirementPage, RequirementAccount, RequirementComment, RequirementCommentQuery } from "@compforge/aide-connector/requirement";
import type { MessageConnector } from "@compforge/aide-connector/message";

export type * from "@compforge/aide-connector/forge";
export type * from "@compforge/aide-connector/environment";
export type * from "@compforge/aide-connector/requirement";
export type * from "@compforge/aide-connector/message";

export interface ConnectorCatalog {
  readonly environments: readonly EnvironmentSummary[];
  readonly requirements: readonly { source: string; provider: string }[];
  readonly forges: readonly { forge: string; provider: string }[];
  readonly messages?: { provider: "lark"; accountId: string; userId: string };
}

/** Host-owned access capabilities, shared by all plugins. No credentials cross this boundary. */
export interface ConnectorClient extends ConnectorAccess {
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
