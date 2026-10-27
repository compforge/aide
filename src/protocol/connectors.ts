import type { MessageConnector, MessageSearchQuery, PullRequestKey, PullRequestQuery, PullRequestScanQuery, RequirementIdentity, RequirementListQuery, RequirementCommentQuery } from "@compforge/aide-plugin";

export type ConnectorRequest =
  | { readonly operation: "describe" }
  | { readonly operation: "messages.identity" }
  | { readonly operation: "messages.search"; readonly query: MessageSearchQuery }
  | { readonly operation: "messages.history"; readonly query: Parameters<MessageConnector["history"]>[0] }
  | { readonly operation: "messages.thread"; readonly query: Parameters<MessageConnector["thread"]>[0] }
  | { readonly operation: "environments.list" }
  | { readonly operation: "environments.workloads"; readonly name: string; readonly namespace?: string }
  | { readonly operation: "environments.get"; readonly name: string }
  | { readonly operation: "requirements.list"; readonly source: string; readonly query?: RequirementListQuery }
  | { readonly operation: "requirements.get"; readonly identity: RequirementIdentity }
  | { readonly operation: "requirements.identity"; readonly source: string }
  | { readonly operation: "requirements.comments"; readonly identity: RequirementIdentity; readonly query?: RequirementCommentQuery }
  | { readonly operation: "forges.scanPullRequests"; readonly forge: string; readonly query: PullRequestScanQuery }
  | { readonly operation: "forges.listPullRequests"; readonly forge: string; readonly query: PullRequestQuery }
  | { readonly operation: "forges.getPullRequest"; readonly key: PullRequestKey }
  | { readonly operation: "forges.getPullRequestReview"; readonly key: PullRequestKey }
  | { readonly operation: "forges.listPullRequestComments"; readonly key: PullRequestKey };
