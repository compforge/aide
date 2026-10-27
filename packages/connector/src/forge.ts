import { defineConnectorKind } from "./contract.ts";
import type { ForgeReader } from "@compforge/repocli";

export type { RepositoryKey, RepositorySnapshot, PullRequestKey, PullRequestSnapshot } from "@compforge/harness-common";
export type { ForgeComment, Page, PageQuery, PullRequestQuery, PullRequestReviewObservation, PullRequestScanQuery, PullRequestScanResult, PullRequestScanCursor, ForgeReadIssue } from "@compforge/repocli";

export type ForgeOperations = Pick<ForgeReader, "listRepositories" | "scanPullRequests" | "listPullRequests" | "getPullRequest" | "getPullRequestReview" | "listPullRequestComments">;
export const ForgeKind = defineConnectorKind<ForgeOperations>({ kind: "forge", version: 1,
  methods: ["listRepositories", "scanPullRequests", "listPullRequests", "getPullRequest", "getPullRequestReview", "listPullRequestComments"] });
