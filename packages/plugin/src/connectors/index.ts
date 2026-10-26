import type { EnvironmentDirectory, EnvironmentSummary } from "./environment.ts";
import type { Requirement, RequirementIdentity, RequirementListQuery, RequirementSummary, RequirementPage, RequirementAccount, RequirementComment, RequirementCommentQuery } from "./requirements.ts";
import type { ForgeComment, PullRequestObservation, PullRequestKey, PullRequestListQuery, PullRequestDiscoveryQuery, PullRequestPage } from "@compforge/repocli";
import type { MessageConnector } from "./messages.ts";

export type * from "./environment.ts";
export type * from "./requirements.ts";
export type { ForgeComment, PullRequestObservation, PullRequestKey, PullRequestListQuery, PullRequestDiscoveryQuery, PullRequestPage } from "@compforge/repocli";
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
    discover(forge: string, query: PullRequestDiscoveryQuery): Promise<PullRequestPage>;
    list(forge: string, path: string, query: PullRequestListQuery): Promise<readonly PullRequestKey[]>;
    get(identity: PullRequestKey): Promise<PullRequestObservation>;
    comments(identity: PullRequestKey): Promise<readonly ForgeComment[]>;
  };
}
