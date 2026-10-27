import { defineConnectorKind } from "../contract.ts";
import type { ForgeReader } from "@compforge/repocli";
import type { RequirementConnector } from "./requirements.ts";
import type { EnvironmentDirectory } from "./environment.ts";
import type { MessageConnector } from "./messages.ts";

export type ForgeOperations = Pick<ForgeReader, "listRepositories" | "scanPullRequests" | "listPullRequests" | "getPullRequest" | "getPullRequestReview" | "listPullRequestComments">;
export const ForgeKind = defineConnectorKind<ForgeOperations>({ kind: "forge", version: 1,
  methods: ["listRepositories", "scanPullRequests", "listPullRequests", "getPullRequest", "getPullRequestReview", "listPullRequestComments"] });
export type RequirementOperations = Pick<RequirementConnector, "list" | "get" | "identity" | "comments">;
export const RequirementKind = defineConnectorKind<RequirementOperations>({ kind: "requirement", version: 1, methods: ["list", "get", "identity", "comments"] });
export const EnvironmentKind = defineConnectorKind<EnvironmentDirectory>({ kind: "environment", version: 1, methods: ["list", "get", "workloads"] });
export const MessageKind = defineConnectorKind<MessageConnector>({ kind: "messages", version: 1, methods: ["identity", "search", "history", "thread"] });
