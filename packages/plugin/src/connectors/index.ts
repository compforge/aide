import type { EnvironmentDirectory, EnvironmentSummary } from "./environment.ts";
import type { Requirement, RequirementIdentity, RequirementListQuery, RequirementSummary } from "./requirements.ts";
import type { Comment, PullRequest, PullRequestIdentity, PullRequestListQuery } from "./forge.ts";

export type * from "./environment.ts";
export type * from "./requirements.ts";
export type * from "./forge.ts";

export interface ConnectorCatalog {
  readonly environments: readonly EnvironmentSummary[];
  readonly requirements: readonly { source: string; provider: string }[];
  readonly forges: readonly { forge: string; provider: string }[];
}

/** Host-owned read capabilities, shared by all plugins. No credentials cross this boundary. */
export interface ConnectorClient {
  describe(): Promise<ConnectorCatalog>;
  readonly environments: EnvironmentDirectory;
  readonly requirements: {
    list(source: string, query?: RequirementListQuery): Promise<readonly RequirementSummary[]>;
    get(identity: RequirementIdentity): Promise<Requirement>;
  };
  readonly forges: {
    list(forge: string, path: string, query: PullRequestListQuery): Promise<readonly PullRequestIdentity[]>;
    get(identity: PullRequestIdentity): Promise<PullRequest>;
    comments(identity: PullRequestIdentity): Promise<readonly Comment[]>;
  };
}
