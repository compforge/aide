import { ForgeKind, ForgeVersion, type ForgeOperations } from "@compforge/aide-connector/forge";
import { EnvironmentKind, EnvironmentVersion, type EnvironmentDirectory } from "@compforge/aide-connector/environment";
import { RequirementKind, RequirementVersion, type RequirementOperations, type RequirementConnector, type RequirementIdentity } from "@compforge/aide-connector/requirement";
import { MessageKind, MessageVersion } from "@compforge/aide-connector/message";
import type { ConnectorClient } from "@compforge/aide-plugin";
import type { ConnectorApi } from "@compforge/aide-connector";
import { ConnectorRegistry, type ConnectorInvocationOptions } from "../src/host/connector/registry.ts";
import { loadConnectorPackages, type ConnectorPackageConfig } from "../src/host/connector/packages.ts";
import type { ForgeReader } from "@compforge/repocli";
import { forgeDefinitions, forgeImplementation } from "./forge/definition.ts";
import { createForgeConnectors, loadForgeConfigs, forgeConnectionRevision } from "./forge/config.ts";
import { createMeegoRequirementConnectors } from "./requirements/meego.ts";
import { resolveEnvironmentConfig } from "./environments/config.ts";
import { Environments } from "./environments.ts";
import { LarkMessages } from "./lark/messages.ts";
import { LarkMessagesConfigSchema } from "./lark/config.ts";
import { emptyConnectors } from "../src/connector-client.ts";

type Configuration = ConnectorPackageConfig & Readonly<Record<string, unknown>> & { environments?: Record<string, unknown>; requirements?: Record<string, unknown>; forges?: Record<string, unknown>; lark?: unknown };

/** One Host registry is shared by typed built-in adapters, arbitrary external kinds, Plugins and verbs. */
export class Connectors implements ConnectorClient {
  readonly requirements: ConnectorClient["requirements"];
  readonly forges: ConnectorClient["forges"];
  readonly environments: EnvironmentDirectory;
  readonly messages: ConnectorClient["messages"];
  readonly list: ConnectorClient["list"];
  readonly get: ConnectorClient["get"];
  readonly call: ConnectorClient["call"];
  constructor(
    private readonly requirementProviders: readonly RequirementConnector[],
    forgeProviders: readonly ForgeReader[],
    environments: EnvironmentDirectory = new Environments(),
    messages: ConnectorClient["messages"] = emptyConnectors.messages,
    private readonly messageAccount?: { provider: "lark"; accountId: string; userId: string },
    readonly registry = new ConnectorRegistry(),
    revisions: Readonly<Record<string, string>> = {},
  ) {
    this.list = registry.list.bind(registry);
    this.get = registry.get.bind(registry);
    this.call = registry.call.bind(registry);
    for (const provider of requirementProviders) registry.register<RequirementOperations>(RequirementKind, RequirementVersion, provider.source, {
      handlers: {
        list: (_call, query) => provider.list(query), get: (_call, identity) => provider.get(identity),
        identity: () => provider.identity(), comments: (_call, identity, query) => provider.comments(identity, query),
      }, metadata: { provider: provider.provider },
    });
    for (const reader of forgeProviders) {
      registry.register(ForgeKind, ForgeVersion, reader.forge, forgeImplementation(reader), { revision: revisions[reader.forge] });
    }
    const environmentRef = registry.register<EnvironmentDirectory>(EnvironmentKind, EnvironmentVersion, "environments", { handlers: {
      list: () => environments.list(), get: (_call, name) => environments.get(name),
      workloads: (_call, name, namespace) => environments.workloads(name, namespace),
    } });
    this.environments = registry.get<EnvironmentDirectory>(environmentRef);
    if (messageAccount) {
      const ref = registry.register<ConnectorClient["messages"]>(MessageKind, MessageVersion, messageAccount.accountId, { handlers: {
        identity: () => messages.identity(), search: (_call, query) => messages.search(query),
        history: (_call, query) => messages.history(query), thread: (_call, query) => messages.thread(query),
      }, metadata: messageAccount });
      this.messages = registry.get<ConnectorClient["messages"]>(ref);
    } else this.messages = messages;
    this.requirements = Object.freeze({
      list: (source, query) => this.client<RequirementOperations>(RequirementKind, RequirementVersion, source).list(query),
      get: identity => this.client<RequirementOperations>(RequirementKind, RequirementVersion, identity.source).get(identity),
      identity: source => this.client<RequirementOperations>(RequirementKind, RequirementVersion, source).identity(),
      comments: (identity, query) => this.client<RequirementOperations>(RequirementKind, RequirementVersion, identity.source).comments(identity, query),
    } satisfies ConnectorClient["requirements"]);
    this.forges = Object.freeze({
      listRepositories: (forge, query) => this.client<ForgeOperations>(ForgeKind, ForgeVersion, forge).listRepositories(query),
      scanPullRequests: (forge, query) => this.client<ForgeOperations>(ForgeKind, ForgeVersion, forge).scanPullRequests(query),
      listPullRequests: (forge, query) => this.client<ForgeOperations>(ForgeKind, ForgeVersion, forge).listPullRequests(query),
      getPullRequest: key => this.client<ForgeOperations>(ForgeKind, ForgeVersion, key.repository.forge.name).getPullRequest(key),
      getPullRequestReview: key => this.client<ForgeOperations>(ForgeKind, ForgeVersion, key.repository.forge.name).getPullRequestReview(key),
      listPullRequestComments: key => this.client<ForgeOperations>(ForgeKind, ForgeVersion, key.repository.forge.name).listPullRequestComments(key),
    } satisfies ConnectorClient["forges"]);
  }
  private client<A extends ConnectorApi<A>>(kind: string, version: string, name: string): A {
    const entries = this.registry.descriptions(kind, version);
    const direct = entries.find(item => item.name === name);
    const matches = direct ? [direct] : entries.filter(item => kind === ForgeKind && item.metadata.forge === name);
    if (matches.length > 1) throw new Error(`Ambiguous Connector selection: ${kind}/${name}; use a discovered reference`);
    const ref = matches[0];
    if (!ref) throw new Error(`Unknown ${kind === "requirement" ? "requirement connector" : kind === "forge" ? "Forge connector" : "connector"}: ${name}`);
    return this.get<A>(ref);
  }
  static fromConfig(config: Configuration, environment: Readonly<Record<string, string | undefined>> = process.env, registry = new ConnectorRegistry()): Connectors {
    if (config.packages?.length || Object.keys(config.connections ?? {}).length) throw new Error("External Connector packages require await Connectors.load()");
    const lark = config.lark === undefined ? undefined : LarkMessagesConfigSchema.parse(config.lark);
    const revisions = Object.fromEntries(loadForgeConfigs(config, environment).map(c => [c.forge, forgeConnectionRevision(c)]));
    return new Connectors(createMeegoRequirementConnectors(config), createForgeConnectors(config, { environment }), new Environments(resolveEnvironmentConfig(config.environments)),
      lark?.appId && lark.userId ? new LarkMessages({ appId: lark.appId, userId: lark.userId, timeoutMs: lark.timeoutMs }) : undefined,
      lark?.appId && lark.userId ? { provider: "lark", accountId: lark.appId, userId: lark.userId } : undefined, registry, revisions);
  }
  static async load(config: Configuration, options: { baseDir?: string; environment?: Readonly<Record<string, string | undefined>>; log?: (message: string, attributes: Record<string, unknown>) => void } = {}): Promise<Connectors> {
    const { packages, connections, ...builtin } = config;
    const connectors = Connectors.fromConfig(builtin, options.environment, new ConnectorRegistry(options.log));
    try { await loadConnectorPackages(connectors.registry, { packages, connections }, { ...options, definitions: forgeDefinitions }); return connectors; }
    catch (error) { await connectors.close(); throw error; }
  }
  async describe() {
    const requirements = await this.list(RequirementKind, RequirementVersion), forges = await this.list(ForgeKind, ForgeVersion);
    return {
      environments: await this.environments.list(),
      requirements: requirements.map(d => ({ source: d.name, provider: String(d.metadata.provider ?? "external") })),
      forges: forges.map(d => ({ forge: String(d.metadata.forge ?? d.name), provider: String(d.metadata.provider ?? "external") })),
      ...(this.messageAccount ? { messages: this.messageAccount } : {}),
    };
  }
  withCallOptions<T>(options: ConnectorInvocationOptions, operation: () => Promise<T>): Promise<T> {
    return this.registry.withCallOptions(options, operation);
  }
  async close(): Promise<void> { await this.registry.close(); }
  /** Output delivery remains a Host-owned write path. */
  async addRequirementComment(identity: RequirementIdentity, comment: { text: string; deliveryId: string }) {
    const provider = this.requirementProviders.find(item => item.source === identity.source);
    if (!provider?.addComment) throw new Error(`Requirement connector does not support comment delivery: ${identity.source}`);
    return provider.addComment(identity, comment);
  }
}
