import { isForgeRateLimitError, type ForgeReader } from "@compforge/repocli";

export type { RepositoryKey, RepositorySnapshot, PullRequestKey, PullRequestSnapshot } from "@compforge/harness-common";
export type { ForgeComment, Page, PageQuery, PullRequestQuery, PullRequestReviewObservation, PullRequestScanQuery, PullRequestScanResult, PullRequestScanCursor, ForgeReadIssue } from "@compforge/repocli";

export type ForgeOperations = Pick<ForgeReader, "listRepositories" | "scanPullRequests" | "listPullRequests" | "getPullRequest" | "getPullRequestReview" | "listPullRequestComments">;
export const ForgeKind = "forge";
export const ForgeVersion = "v1";

import type { ConnectorImplementation } from "./contract.ts";
/**
 * @spec Every Forge provider uses the same Host adapter, including rate-limit issues and cooperative cancellation.
 * @link docs/connector/extensions.md
 */
export function forgeImplementation(reader: ForgeReader): ConnectorImplementation<ForgeOperations> {
  const invoke = <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => reader.withSignal ? reader.withSignal(signal, operation) : operation();
  return { close: () => reader.close?.(), metadata: { forge: reader.forge, provider: reader.provider }, handlers: {
    async listRepositories(call, query) {
      try { return await invoke(call.signal, () => reader.listRepositories(query)); }
      catch (error) {
        if (!isForgeRateLimitError(error)) throw error;
        return { items: [], issues: [{ stage: "list", kind: "rate_limit", message: error.message, retryAfterMs: error.retryAfterMs }] };
      }
    },
    scanPullRequests: (call, query) => invoke(call.signal, () => reader.scanPullRequests(query)),
    listPullRequests: (call, query) => invoke(call.signal, () => reader.listPullRequests(query)),
    getPullRequest: (call, key) => invoke(call.signal, () => reader.getPullRequest(key)),
    getPullRequestReview: (call, key) => invoke(call.signal, () => reader.getPullRequestReview(key)),
    listPullRequestComments: (call, key) => invoke(call.signal, () => reader.listPullRequestComments(key)),
  } };
}
