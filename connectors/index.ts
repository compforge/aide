import { ForgeKind } from "@compforge/aide-connector/forge";
import { EnvironmentKind, type EnvironmentDirectory } from "@compforge/aide-connector/environment";
import { RequirementKind, type RequirementOperations, type RequirementConnector, type RequirementIdentity } from "@compforge/aide-connector/requirement";
import { MessageKind } from "@compforge/aide-connector/message";
import type { ConnectorClient } from "@compforge/aide-plugin";
import type { ConnectorCallOptions, ConnectorApi, ConnectorKind, ConnectorHandlers } from "@compforge/aide-connector";
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

/** Bind existing access adapters to a Kind without copying client state or exposing credentials. */
function handlers<A extends ConnectorApi<A>>(kind: ConnectorKind<A>, target: A): ConnectorHandlers<A> {
  return Object.fromEntries(kind.methods.map(method => [method, (...args: unknown[]) => {
    args.shift(); // The first argument is the Host's per-call context.
    return target[method].apply(target, args);
  }])) as unknown as ConnectorHandlers<A>;
}
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
    for (const provider of requirementProviders) registry.register(RequirementKind, provider.source, {
      handlers: handlers<RequirementOperations>(RequirementKind, provider), metadata: { provider: provider.provider },
    });
    for (const reader of forgeProviders) {
      registry.register(ForgeKind, reader.forge, forgeImplementation(reader), { revision: revisions[reader.forge] });
    }
    const environmentRef = registry.register(EnvironmentKind, "environments", { handlers: handlers(EnvironmentKind, environments) });
    this.environments = registry.get(EnvironmentKind, environmentRef);
    if (messageAccount) {
      const ref = registry.register(MessageKind, messageAccount.accountId, { handlers: handlers(MessageKind, messages), metadata: messageAccount });
      this.messages = registry.get(MessageKind, ref);
    } else this.messages = messages;
    this.requirements = Object.freeze({
      list: (source, query) => this.client(RequirementKind, source).list(query),
      get: identity => this.client(RequirementKind, identity.source).get(identity),
      identity: source => this.client(RequirementKind, source).identity(),
      comments: (identity, query) => this.client(RequirementKind, identity.source).comments(identity, query),
    } satisfies ConnectorClient["requirements"]);
    this.forges = Object.freeze({
      listRepositories: (forge, query) => this.client(ForgeKind, forge).listRepositories(query),
      scanPullRequests: (forge, query) => this.client(ForgeKind, forge).scanPullRequests(query),
      listPullRequests: (forge, query) => this.client(ForgeKind, forge).listPullRequests(query),
      getPullRequest: key => this.client(ForgeKind, key.repository.forge.name).getPullRequest(key),
      getPullRequestReview: key => this.client(ForgeKind, key.repository.forge.name).getPullRequestReview(key),
      listPullRequestComments: key => this.client(ForgeKind, key.repository.forge.name).listPullRequestComments(key),
    } satisfies ConnectorClient["forges"]);
  }
  private client<A extends ConnectorApi<A>>(kind: ConnectorKind<A>, name: string): A {
    const entries = this.registry.descriptions(kind.kind, kind.version);
    const direct = entries.find(item => item.name === name);
    const matches = direct ? [direct] : entries.filter(item => kind.kind === ForgeKind.kind && item.metadata.forge === name);
    if (matches.length > 1) throw new Error(`Ambiguous Connector selection: ${kind.kind}/${name}; use a discovered reference`);
    const ref = matches[0];
    if (!ref) throw new Error(`Unknown ${kind.kind === "requirement" ? "requirement connector" : kind.kind === "forge" ? "Forge connector" : "connector"}: ${name}`);
    return this.get(kind, ref);
  }
  static fromConfig(config: Configuration, environment: Readonly<Record<string, string | undefined>> = process.env, registry = new ConnectorRegistry()): Connectors {
    if (config.packages?.length || Object.keys(config.instances ?? {}).length) throw new Error("External Connector packages require await Connectors.load()");
    const lark = config.lark === undefined ? undefined : LarkMessagesConfigSchema.parse(config.lark);
    const revisions = Object.fromEntries(loadForgeConfigs(config, environment).map(c => [c.forge, forgeConnectionRevision(c)]));
    return new Connectors(createMeegoRequirementConnectors(config), createForgeConnectors(config, { environment }), new Environments(resolveEnvironmentConfig(config.environments)),
      lark?.appId && lark.userId ? new LarkMessages({ appId: lark.appId, userId: lark.userId, timeoutMs: lark.timeoutMs }) : undefined,
      lark?.appId && lark.userId ? { provider: "lark", accountId: lark.appId, userId: lark.userId } : undefined, registry, revisions);
  }
  static async load(config: Configuration, options: { baseDir?: string; environment?: Readonly<Record<string, string | undefined>>; log?: (message: string, attributes: Record<string, unknown>) => void } = {}): Promise<Connectors> {
    const { packages, instances, ...builtin } = config;
    const connectors = Connectors.fromConfig(builtin, options.environment, new ConnectorRegistry(options.log));
    try { await loadConnectorPackages(connectors.registry, { packages, instances }, { ...options, definitions: forgeDefinitions }); return connectors; }
    catch (error) { await connectors.close(); throw error; }
  }
  async describe() {
    const requirements = await this.list(RequirementKind), forges = await this.list(ForgeKind);
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
