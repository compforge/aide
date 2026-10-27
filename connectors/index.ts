import type { ConnectorClient, EnvironmentDirectory, RequirementConnector } from "@compforge/aide-plugin";
import { ForgeRateLimitError, type ForgeReader } from "@compforge/repocli";
import { createForgeConnectors } from "./forge/config.ts";
import { createMeegoRequirementConnectors } from "./requirements/meego.ts";
import { resolveEnvironmentConfig } from "./environments/config.ts";
import { Environments } from "./environments.ts";
import { LarkMessages } from "./lark/messages.ts";
import { LarkMessagesConfigSchema } from "./lark/config.ts";
import { emptyConnectors } from "../src/connector-client.ts";

/** One host-owned set of provider clients; plugins receive only read capabilities. */
export class Connectors implements ConnectorClient {
  readonly requirements: ConnectorClient["requirements"];
  readonly forges: ConnectorClient["forges"];
  constructor(
    private readonly requirementProviders: readonly RequirementConnector[],
    private readonly forgeProviders: readonly ForgeReader[],
    readonly environments: EnvironmentDirectory = new Environments(),
    readonly messages: ConnectorClient["messages"] = emptyConnectors.messages,
    private readonly messageAccount?: { provider: "lark"; accountId: string; userId: string },
  ) {
    this.requirements = Object.freeze({
      list: (source, query) => this.requirement(source).list(query),
      get: (identity) => this.requirement(identity.source).get(identity),
      identity: (source) => this.requirement(source).identity(),
      comments: (identity, query) => this.requirement(identity.source).comments(identity, query),
    } satisfies ConnectorClient["requirements"]);
    this.forges = Object.freeze({
      listRepositories: async (forge, query) => {
        try { return await this.forge(forge).listRepositories(query); }
        catch (error) {
          if (!(error instanceof ForgeRateLimitError)) throw error;
          return { items: [], issues: [{ stage: "list", kind: "rate_limit", message: error.message, retryAfterMs: error.retryAfterMs }] };
        }
      },
      scanPullRequests: (forge, query) => this.forge(forge).scanPullRequests(query),
      listPullRequests: (forge, query) => this.forge(forge).listPullRequests(query),
      getPullRequest: (key) => this.forge(key.repository.forge.name).getPullRequest(key),
      getPullRequestReview: (key) => this.forge(key.repository.forge.name).getPullRequestReview(key),
      listPullRequestComments: (key) => this.forge(key.repository.forge.name).listPullRequestComments(key),
    } satisfies ConnectorClient["forges"]);
  }

  static fromConfig(config: { environments?: Record<string, unknown>; requirements?: Record<string, unknown>; forges?: Record<string, unknown>; lark?: unknown }, environment: Readonly<Record<string, string | undefined>> = process.env): Connectors {
    const lark = config.lark === undefined ? undefined : LarkMessagesConfigSchema.parse(config.lark);
    return new Connectors(createMeegoRequirementConnectors(config), createForgeConnectors(config, { environment }), new Environments(resolveEnvironmentConfig(config.environments)),
      lark?.appId && lark.userId ? new LarkMessages({ appId: lark.appId, userId: lark.userId, timeoutMs: lark.timeoutMs }) : undefined, lark?.appId && lark.userId ? { provider: "lark", accountId: lark.appId, userId: lark.userId } : undefined);
  }

  async describe() {
    return {
      environments: await this.environments.list(),
      requirements: this.requirementProviders.map(({ source, provider }) => ({ source, provider })),
      forges: this.forgeProviders.map(({ forge, provider }) => ({ forge, provider })),
      ...(this.messageAccount ? { messages: this.messageAccount } : {}),
    };
  }

  /** Output delivery is owned by the Host and is not exposed over the read-only Connector IPC. */
  async addRequirementComment(identity: import("@compforge/aide-plugin").RequirementIdentity, comment: { text: string; deliveryId: string }) {
    const provider = this.requirement(identity.source);
    if (!provider.addComment) throw new Error("Requirement connector does not support comment delivery");
    return provider.addComment(identity, comment);
  }

  private requirement(source: string): RequirementConnector {
    const connector = this.requirementProviders.find((item) => item.source === source);
    if (!connector) throw new Error(`Unknown requirement connector: ${source}`);
    return connector;
  }

  private forge(forge: string): ForgeReader {
    const connector = this.forgeProviders.find((item) => item.forge === forge);
    if (!connector) throw new Error(`Forge ${forge} is not configured with credentials`);
    return connector;
  }
}
