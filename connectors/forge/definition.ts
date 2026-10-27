import { z } from "zod";
import { createForgeReader, ForgeRateLimitError, type ForgeReader } from "@compforge/repocli";
import { ForgeKind, ForgeVersion, type ForgeOperations } from "@compforge/aide-connector/forge";
import type { ConnectorDefinition, ConnectorImplementation } from "@compforge/aide-connector";

export function forgeImplementation(reader: ForgeReader): ConnectorImplementation<ForgeOperations> {
  return { metadata: { forge: reader.forge, provider: reader.provider }, handlers: {
    async listRepositories(_call, query) {
      try { return await reader.listRepositories(query); }
      catch (error) {
        if (!(error instanceof ForgeRateLimitError)) throw error;
        return { items: [], issues: [{ stage: "list", kind: "rate_limit", message: error.message, retryAfterMs: error.retryAfterMs }] };
      }
    },
    scanPullRequests: (_call, query) => reader.scanPullRequests(query),
    listPullRequests: (_call, query) => reader.listPullRequests(query),
    getPullRequest: (_call, key) => reader.getPullRequest(key),
    getPullRequestReview: (_call, key) => reader.getPullRequestReview(key),
    listPullRequestComments: (_call, key) => reader.listPullRequestComments(key),
  } };
}
const ConfigSchema = z.object({ host: z.string().trim().min(1), forge: z.string().trim().min(1).optional(),
  tokenEnv: z.string().min(1).optional(), token: z.string().trim().min(1).optional() }).strict();
const definition = (provider: "github" | "gitlab"): ConnectorDefinition<z.infer<typeof ConfigSchema>, ForgeOperations> => ({
  type: provider, kind: ForgeKind, version: ForgeVersion, config: ConfigSchema,
  create(context, config) {
    const token = config.tokenEnv ? context.env(config.tokenEnv) : provider === "github"
      ? context.env("GITHUB_TOKEN") || context.env("GH_TOKEN") : context.env("GITLAB_TOKEN");
    if (!token && !config.token) throw new Error("Forge credential is missing");
    return forgeImplementation(createForgeReader({ forge: config.forge ?? config.host, host: config.host, provider, token: token ?? config.token! }));
  },
});
export const forgeDefinitions = [definition("github"), definition("gitlab")] as const;
