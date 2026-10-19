import type { PullRequestIdentity, PullRequestListQuery, RequirementIdentity, RequirementListQuery } from "@compforge/aide-plugin";

export type ConnectorRequest =
  | { readonly operation: "describe" }
  | { readonly operation: "environments.list" }
  | { readonly operation: "environments.get"; readonly name: string }
  | { readonly operation: "requirements.list"; readonly source: string; readonly query?: RequirementListQuery }
  | { readonly operation: "requirements.get"; readonly identity: RequirementIdentity }
  | { readonly operation: "forges.list"; readonly forge: string; readonly path: string; readonly query: PullRequestListQuery }
  | { readonly operation: "forges.get"; readonly identity: PullRequestIdentity }
  | { readonly operation: "forges.comments"; readonly identity: PullRequestIdentity };
