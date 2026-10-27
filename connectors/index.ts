import { ForgeKind, ForgeVersion, type ForgeOperations } from "@compforge/aide-connector/forge";
import { EnvironmentKind, EnvironmentVersion, type EnvironmentDirectory } from "@compforge/aide-connector/environment";
import { RequirementKind, RequirementVersion, type RequirementOperations, type RequirementConnector, type RequirementIdentity } from "@compforge/aide-connector/requirement";
import { MessageKind, MessageVersion } from "@compforge/aide-connector/message";
import type { ConnectorClient } from "@compforge/aide-plugin";
import type { ConnectorApi } from "@compforge/aide-connector";
import { ConnectorRegistry, type ConnectorInvocationOptions } from "../src/host/connector/registry.ts";
import { loadConnectorPackages, type ConnectorConfigurations } from "../src/host/connector/packages.ts";
import { emptyConnectors } from "../src/connector-client.ts";
import { builtinDefinitions } from "./definitions.ts";

/** One Host registry is shared by typed built-in adapters, arbitrary external kinds, Plugins and verbs. */
export class Connectors implements ConnectorClient {
  readonly requirements: ConnectorClient["requirements"];
  readonly forges: ConnectorClient["forges"];
  readonly environments: EnvironmentDirectory;
  readonly messages: ConnectorClient["messages"];
  readonly list: ConnectorClient["list"];
  readonly get: ConnectorClient["get"];
  readonly call: ConnectorClient["call"];
  constructor(readonly registry = new ConnectorRegistry(), private readonly requirementProviders: readonly RequirementConnector[] = []) {
    this.list = registry.list.bind(registry);
    this.get = registry.get.bind(registry);
    this.call = registry.call.bind(registry);
    const environmentClient = () => this.single<EnvironmentDirectory>(EnvironmentKind, EnvironmentVersion);
    this.environments = {
      list: () => environmentClient()?.list() ?? Promise.resolve([]),
      get: name => { const client = environmentClient(); if (!client) return Promise.reject(new Error(`Unknown environment: ${name}`)); return client.get(name); },
      workloads: (name, namespace) => { const client = environmentClient(); if (!client) return Promise.reject(new Error(`Unknown environment: ${name}`)); return client.workloads(name, namespace); },
    };
    const messages = () => this.single<ConnectorClient["messages"]>(MessageKind, MessageVersion) ?? emptyConnectors.messages;
    this.messages = {
      identity: () => messages().identity(), search: query => messages().search(query),
      history: query => messages().history(query), thread: query => messages().thread(query),
    };
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
  private single<A extends ConnectorApi<A>>(kind: string, version: string): A | undefined {
    const entries = this.registry.descriptions(kind, version);
    if (entries.length > 1) throw new Error(`Ambiguous Connector selection: ${kind}; use a discovered reference`);
    return entries[0] ? this.get<A>(entries[0]) : undefined;
  }
  static async load(config: ConnectorConfigurations, options: { registration?: string; baseDir?: string; environment?: Readonly<Record<string, string | undefined>>; log?: (message: string, attributes: Record<string, unknown>) => void } = {}): Promise<Connectors> {
    const providers: RequirementConnector[] = [];
    const registry = new ConnectorRegistry(options.log);
    try {
      await loadConnectorPackages(registry, config, { ...options, definitions: builtinDefinitions(providers) });
      return new Connectors(registry, providers);
    } catch (error) { await registry.close(); throw error; }
  }
  async describe() {
    const requirements = await this.list(RequirementKind, RequirementVersion), forges = await this.list(ForgeKind, ForgeVersion);
    const messages = this.registry.descriptions(MessageKind, MessageVersion);
    const metadata = messages.length === 1 ? messages[0]!.metadata : undefined;
    const messageAccount = metadata?.provider === "lark" && typeof metadata.accountId === "string" && typeof metadata.userId === "string"
      ? { provider: "lark" as const, accountId: metadata.accountId, userId: metadata.userId } : undefined;
    return {
      environments: await this.environments.list(),
      requirements: requirements.map(d => ({ source: d.name, provider: String(d.metadata.provider ?? "external") })),
      forges: forges.map(d => ({ forge: String(d.metadata.forge ?? d.name), provider: String(d.metadata.provider ?? "external") })),
      ...(messageAccount ? { messages: messageAccount } : {}),
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
