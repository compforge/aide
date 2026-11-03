import { isMe } from "../plugins/personal/person/model.ts";
import { addressRef, type AddressRef } from "../plugins/personal/address/model.ts";
import { Addresses } from "../plugins/personal/address/service.ts";
import { OutputDelivery, type OutputTransportResolver } from "../plugins/personal/output/delivery.ts";
import { forgeCatalog } from "../connectors/forge/catalog.ts";
import { validateForgeSources } from "../plugins/personal/source/pull-request/config.ts";
import { personalConnectorConfig } from "../plugins/personal/source/connectors.ts";
import { iconFor } from "@compforge/aide-plugin";
import { initialTopicName } from "../plugins/personal/topic/model.ts";
import { ROUTE_HARNESS } from "../plugins/personal/route/model.ts";
import { personalExecution } from "../plugins/personal/execution-context.ts";
import { ResourceStorage } from "./host/resource/storage.ts";
import { OutputDisclosure, type SemanticCheck } from "../plugins/personal/output/disclosure.ts";
import { isChannelAddress } from "./channel/address.ts";
import { SayInputSchema } from "../plugins/personal/output/action.ts";
import { personalAdmission } from "../plugins/personal/admission.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { outputView } from "../plugins/personal/output/view.ts";
import { personRequirements } from "../plugins/personal/person/requirements.ts";
import { requirementOutputs } from "../plugins/personal/output/requirements.ts";
import { personMessages } from "../plugins/personal/person/messages.ts";
import { enabledLarkApps } from "./channel/config.ts";
import { personRef } from "../plugins/personal/person/model.ts";
import { larkPersonAddress, webAddress, assertChannelDelivery } from "./channel/address.ts";
import { CHANNELS, type ChannelDefinition } from "./channel/definition.ts";
import { SOURCES } from "../plugins/personal/source/definition.ts";
import type { SourceDefinition } from "../plugins/personal/source/input.ts";
import type { InputSpec } from "../plugins/personal/input/model.ts";
import { resolve } from "node:path";
import { LOCAL_ME, type Me, type PersonIdentity } from "../plugins/personal/person/model.ts";
import personalDefinitions from "../plugins/personal/definitions.ts";
import { openPersonCatalog } from "../plugins/personal/person/catalog.ts";
import type { Logger } from "pino";
import type { ConnectorClient } from "@compforge/aide-plugin";
import { Personal } from "../plugins/personal/aide.ts";
import { environmentSources } from "../plugins/personal/source/environment/config.ts";
import { InputStore } from "../plugins/personal/input/store.ts";
import { requirementWatches, validateWatchScopes } from "../plugins/personal/source/requirement/config.ts";
import { parsePersonalConfig } from "../plugins/personal/config.ts";
import { messageWatch } from "../plugins/personal/source/message/config.ts";
import { requirementCatalog } from "../connectors/requirements/catalog.ts";
import { Connectors } from "../connectors/index.ts";
import type { AideConfig, DefaultHarness } from "./config.ts";
import { type ExecutionOptions } from "./host/runtime/execution.ts";
import { ApplicationRuntime } from "./host/runtime/index.ts";
import { PluginSupervisor } from "./host/plugin/runner/index.ts";
import { IncomingSchema, type Incoming } from "./channel/message.ts";

export interface AideOptions {
  checkDisclosure?: SemanticCheck;
  connectorCatalog?: readonly import("@compforge/aide-connector").ConnectorDescription[];
  cwd: string; timezone: string; config?: AideConfig; connectors?: ConnectorClient;
  defaultHarnessConfig: Readonly<{ id: string; harness: DefaultHarness; model?: string }>;
  createAdapter: ExecutionOptions["createAdapter"];
  readSession?: import("../plugins/personal/observation/session.ts").ReadSession;
}

/**
 * @spec The application composes one generic runtime with the Personal domain plugin.
 * @why Transport topics select business context, never a separate scheduler or resource store.
 * @link docs/kernel.md
 */
export class Aide {
  readSession?: import("../plugins/personal/observation/session.ts").ReadSession;
  private readonly inputDefinitions = new Map<string, ChannelDefinition | SourceDefinition>([
    ...Object.values(CHANNELS).map((definition) => [`channel:${definition.id}`, definition] as const),
    ...Object.values(SOURCES).map((definition) => [`source:${definition.id}`, definition] as const),
  ]);
  inputDefinition(origin: Pick<InputSpec, "origin" | "originId">) {
    if (["aide:review", "aide:triage", "aide:organize"].includes(origin.origin)) return { id: origin.origin, label: ({ "aide:review": "回顾", "aide:triage": "分理", "aide:organize": "组织" } as Record<string, string>)[origin.origin]!, icon: iconFor("harness:chief") };
    if (origin.origin === "chief" && origin.originId === "personal.chief") return { id: origin.originId, label: "Chief 请求", icon: iconFor("harness:chief") };
    const definition = this.inputDefinitions.get(`${origin.origin}:${origin.originId}`);
    if (!definition) throw new Error(`Unknown input definition: ${origin.origin}:${origin.originId}`);
    return definition;
  }

  readonly runtime: ApplicationRuntime;
  readonly personal: Personal;
  private readonly defaultHarnessConfig: AideOptions["defaultHarnessConfig"];
  private readonly listeners = new Set<() => void>();
  private readonly watches: ReturnType<typeof requirementWatches>;
  private readonly environmentSources: ReturnType<typeof environmentSources>;
  private readonly messageSource: ReturnType<typeof messageWatch>;
  private readonly inputs: InputStore;
  readonly outputStore: OutputStore;
  readonly addresses: Addresses;
  private readonly disclosure: OutputDisclosure;
  private readonly delivery: OutputDelivery;
  private readonly outputTransports = new Set<OutputTransportResolver>();
  private readonly unsubscribeOutputs: () => void;
  private readonly unsubscribeResources: () => void;
  private readonly connectors: ConnectorClient;
  private readonly ownedConnectors?: Connectors;
  private readonly requirementConnections: ReturnType<typeof requirementCatalog>;
  private readonly meMarks: Me & { identities: PersonIdentity[] };
  readonly catalog: ReturnType<typeof openPersonCatalog>;
  get persons() { return this.catalog.persons; }
  private starting?: Promise<void>;
  private closed = false;

  constructor(home: string, private readonly options: AideOptions, private readonly log: Logger) {
    this.readSession = options.readSession;
    this.defaultHarnessConfig = Object.freeze({ ...options.defaultHarnessConfig });
    const config = options.config;
    if (!options.connectors && Object.values(config?.connectors ?? {}).some(c => c.enabled)) {
      throw new Error("Configured Connectors require await Connectors.load() before constructing Aide");
    }
    const { sources } = parsePersonalConfig(config?.plugins.personal);
    const personalConnectors = personalConnectorConfig(config?.connectors);
    const connectorCatalog = options.connectorCatalog ?? (options.connectors instanceof Connectors ? options.connectors.registry.descriptions() : []);
    const discoveredForges = forgeCatalog(connectorCatalog);
    validateForgeSources(sources.repositories, sources.pullRequests, discoveredForges);
    const forgeConnectionRevisions = Object.fromEntries(discoveredForges.map(d => [d.forge, d.revision]));
    const connectorMe = { identities: [
      ...(personalConnectors.lark?.me ?? []).map(i => ({ provider: "lark", scope: i.appId, id: i.openId })),
      ...discoveredForges.flatMap(d => d.me ? [{ provider: d.provider, scope: d.forge, id: d.me.username }] : []),
    ] };
    const channelMe = { identities: [LOCAL_ME, ...Object.values(config?.channels ?? {}).flatMap(c => c.me ? [{ provider: "lark", scope: c.appId, id: c.me.openId }] : [])] };
    this.meMarks = { identities: [...channelMe.identities, ...connectorMe.identities] };
    this.meMarks.identities = [...new Map(this.meMarks.identities.map(identity => [JSON.stringify(identity), identity])).values()];
    const requirements = this.requirementConnections = requirementCatalog(connectorCatalog);
    this.watches = requirementWatches(sources.requirements).map(watch => {
      const me = requirements.find(c => c.source === watch.source)?.me;
      return { ...watch, ...(me ? { me } : {}) };
    });
    this.messageSource = messageWatch(sources.lark, personalConnectors.lark, connectorMe);
    const environments = personalConnectors.environments;
    this.environmentSources = environmentSources(sources.environments, environments);
    const storage = ResourceStorage.open(home);
    storage.configure(config?.resources);
    storage.register("personal", personalDefinitions);
    this.addresses = new Addresses(home);
    this.inputs = new InputStore(home);
    this.outputStore = new OutputStore(home, target => assertChannelDelivery(target, enabledLarkApps(config?.channels ?? {})));
    this.unsubscribeOutputs = this.outputStore.subscribe(() => this.notify());
    this.inputs.storage.onRetentionError = (resource, error) => this.log.error({ err: error, kind: resource.kind, uid: resource.metadata.uid }, "Resource retention decision failed; preserved resource");
    this.unsubscribeResources = this.inputs.storage.subscribe((scope, resource) => { this.log.info({ scope, kind: resource.kind, uid: resource.metadata.uid }, "Resource reclaimed"); });
    validateWatchScopes(this.watches, requirements);
    this.log.info({
      meIdentities: this.meMarks.identities.length,
      repositories: sources.repositories.map(({ id, forge, refreshIntervalMs }) => ({ id, forge, refreshIntervalMs })),
      pullRequests: sources.pullRequests.map(({ id, intervalMs }) => ({ id, intervalMs })),
      environments: this.environmentSources.map(({ environment, namespace, intervalMs }) => ({ environment, namespace, intervalMs })),
      requirements: this.watches.map(({ id, source, intervalMs }) => ({ id, connector: source, intervalMs })),
      lark: this.messageSource ? { intervalMs: this.messageSource.intervalMs, scenarios: ["direct", "mention", ...(this.messageSource.personIds.length ? ["sent"] : [])] } : null,
    }, "Personal observation sources configured");
    const connectors = options.connectors ?? (this.ownedConnectors = new Connectors());
    this.catalog = openPersonCatalog(home, this.meMarks, log, () => this.notify());
    this.connectors = { ...(connectors instanceof Connectors ? { withCallOptions: connectors.withCallOptions.bind(connectors) } : {}), list: (kind, version) => connectors.list(kind, version), get: connectors.get.bind(connectors), call: connectors.call.bind(connectors), requirements: requirementOutputs(personRequirements(connectors.requirements, this.persons), this.outputStore), forges: connectors.forges,
      environments: connectors.environments, describe: () => connectors.describe(),
      messages: personalConnectors.lark?.appId ? personMessages(connectors.messages, this.persons, personalConnectors.lark.appId) : connectors.messages };
    let personal: Personal | undefined;
    this.runtime = new ApplicationRuntime(home, {
      cwd: options.cwd,
      instances: [{ pluginInstanceId: "personal", pluginId: "aide.personal", packageVersion: "0.1.0", marketplace: "builtin", config: JSON.parse(JSON.stringify({ weave: parsePersonalConfig(config?.plugins.personal).weave, route: parsePersonalConfig(config?.plugins.personal).route, topic: parsePersonalConfig(config?.plugins.personal).topic, task: parsePersonalConfig(config?.plugins.personal).task, routine: parsePersonalConfig(config?.plugins.personal).routine, watches: this.watches,
        forgeConnectionRevisions, repositorySources: sources.repositories, pullRequestSources: sources.pullRequests, environmentSources: this.environmentSources, ...(this.messageSource ? { messageSource: this.messageSource } : {}) })) }],
      harness: { harnesses: [{ ...this.defaultHarnessConfig }, { id: "weave", harness: "weave" }, { id: ROUTE_HARNESS, harness: "route" }, { id: "chief", harness: "chief" }, { id: "task", harness: "task" }, { id: "routine", harness: "routine" }],
        defaultHarness: this.defaultHarnessConfig.id, createAdapter: options.createAdapter },
      plugins: { maxTotalConcurrency: config?.reconcile?.maxTotalConcurrency, connectors: this.connectors, resourceAdmissions: { personal: personalAdmission(this.inputs, this.outputStore) },
        onResourceChange: (change) => { personal?.topics.changed(change); this.notify(); },
        actions: { "personal/reconcile_output": async (context, raw) => {
          const id = (raw as { id: string }).id;
          if (context.resourceRef?.kind !== "Output" || context.resourceRef.name !== id) throw new Error("Output reconcile requires its own resource context");
          return { outputId: id, ...await this.delivery.reconcile(id) };
        }, "personal/submit_topic": (context, input) => this.personal.submitTopic(context, input), "personal/submit_input": (context, input) => this.personal.submitInput(context, input), "personal/say": (context, raw) => {
          const input = SayInputSchema.parse(raw);
          const text = input.text;
          const association = personalExecution(context);
          if (!association.topicId) throw new Error("Personal say requires Topic context");
          const owner = context.resourceRef && ["Task", "Routine"].includes(context.resourceRef.kind) ? this.personal.store.resources.get<unknown, { execution?: { id: string } | null }>(context.resourceRef, context.resourceRef.name, context.resourceRef.namespace) : undefined;
          if (owner && (owner.metadata.deletionTimestamp || owner.metadata.uid !== context.resourceRef?.uid)) throw new Error("Work Output owner is no longer active");
          return this.personal.topics.say(association.topicId, association.inputId, text, context.executionId, input, owner);
        } },
        pluginSupervisor: new PluginSupervisor(),
        loadPackageEntry: async (pluginId, version) => {
          if (pluginId !== "aide.personal" || version !== "0.1.0") throw new Error(`Plugin package is not installed: ${pluginId}@${version}`);
          return { pluginId, version, entryUrl: new URL("../plugins/personal/plugin.ts", import.meta.url).href,
            resourcesUrl: new URL("../plugins/personal/definitions.ts", import.meta.url).href };
        }, onRunnerFailure: async ({ error }) => {
          this.log.error({ err: error }, "Personal Runner stopped");
          await personal?.recoverInterrupted();
        },
      },
    });
    this.personal = personal = new Personal({ timezone: options.timezone, persons: this.persons, channelMe,
      topic: parsePersonalConfig(config?.plugins.personal).topic, weave: parsePersonalConfig(config?.plugins.personal).weave }, log,
      { runtime: this.runtime, connectors: this.connectors, inputs: this.inputs, outputs: this.outputStore, resolveContact: () => this.resolveContact() });
    this.disclosure = new OutputDisclosure(this.outputStore, { marks: this.meMarks,
      audience: target => this.outputAudience(target), contactMe: async () => { const address = this.defaultAddress(); return { address, target: this.addresses.endpoint(address), receivers: [] }; }, check: options.checkDisclosure }, log);
    this.outputStore.check = id => this.disclosure.reconcile(id);
    this.delivery = new OutputDelivery(this.outputStore, async target => {
      if (isChannelAddress(target) && target.channelId === "web") return { replay: "idempotent", async send() { return undefined; } };
      for (const resolve of this.outputTransports) { const transport = await resolve(target); if (transport) return transport; }
    }, log);
    this.runtime.subscribe(() => this.notify());
    this.personal.topics.subscribe(() => this.notify());
  }

  health(): { status: "ok" | "unavailable"; unavailablePlugins: string[] } {
    const unavailablePlugins = this.runtime.plugins.listInstances().filter(instance => instance.enabled
      && !this.runtime.plugins.isInstanceActive(instance.pluginInstanceId)).map(instance => instance.pluginInstanceId);
    return { status: unavailablePlugins.length ? "unavailable" : "ok", unavailablePlugins };
  }

  get topics() { return this.personal.topics; }

  async receive(raw: unknown) {
    const input = IncomingSchema.parse(raw);
    this.inputDefinition({ origin: "channel", originId: input.channelId });
    if (input.source.channelId !== input.channelId) throw new Error("Channel input address belongs to a different Channel");
    const scope = this.personal;
    await this.start();
    return scope.receive(input);
  }

  async event(input: Omit<Incoming, "channelId" | "source"> & { name: string; topicId?: string }): Promise<number> {
    const scope = this.personal;
    await this.start(); await scope.start();
    if (!input.topicId) throw new Error("Event requires an explicit Topic");
    return scope.event({ ...input, topicId: input.topicId });
  }

  work(topicId: string) { return this.personal.work(topicId); }

  weaveSession(scope: Parameters<Personal["weaveSession"]>[0], config: Parameters<Personal["weaveSession"]>[1]) { return this.personal.weaveSession(scope, config); }

  routeSession(scope: Parameters<Personal["routeSession"]>[0], config: Parameters<Personal["routeSession"]>[1]) { return this.personal.routeSession(scope, config); }

  routineSession(scope: Parameters<Personal["routineSession"]>[0], config: Parameters<Personal["routineSession"]>[1]) { return this.personal.routineSession(scope, config); }

  taskSession(scope: Parameters<Personal["taskSession"]>[0], config: Parameters<Personal["taskSession"]>[1]) { return this.personal.taskSession(scope, config); }

  chiefSession(scope: Parameters<Personal["chiefSession"]>[0], config: Parameters<Personal["chiefSession"]>[1]) {
    return this.personal.chiefSession(scope, config);
  }

  registerOutputTransport(resolve: OutputTransportResolver): () => void {
    this.outputTransports.add(resolve);
    return () => { this.outputTransports.delete(resolve); };
  }
  async reconcileOutput(id: string): Promise<void> { await this.delivery.reconcile(id); }
  outputs() { return this.outputStore.list().map(outputView).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)); }

  works() { return this.personal.works(); }
  invocations() { return this.personal.invocations(); }
  topicIds() { return this.personal.topicIds(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { for (const listener of this.listeners) listener(); }
  async deleteTopic(topicId: string, revision: number, uid: string): Promise<import("../plugins/personal/topic/model.ts").TopicDeletion> {
    const scope = this.personal;
    const result = await scope.deleteTopic(topicId, revision, uid);
    if (result.deleted) this.notify();
    return result;
  }

  async setTopicReview(topicId: string, enabled: boolean) {
    const scope = this.personal;
    if (!this.topics.get(topicId)) throw new Error("Topic does not exist");
    const review = await scope.topics.setReviewEnabled(topicId, enabled);
    this.log.info({ topicId, ...review }, "Topic review configured");
    this.notify();
    return review;
  }

  /** @spec Business routing selects an Address incarnation; endpoint resolution and permissions are read-only.
   * @link docs/personal/address.md
   */
  defaultAddress(): AddressRef {
    if (this.options.config?.defaultAddress) return this.options.config.defaultAddress;
    const address = this.addresses.find(webAddress("me"));
    if (!address) throw new Error("Me Web inbox is not initialized");
    return addressRef(address);
  }

  async validateDefaultAddress(ref: AddressRef): Promise<void> {
    const audience = await this.outputAudience(ref);
    if (audience.unavailable || !audience.private || !audience.people.length || audience.people.some(p => !isMe(p.spec, this.meMarks)))
      throw new Error("Default Address must be a private, available destination for Me");
  }

  private async resolveContact() {
    const target = this.defaultAddress();
    await this.validateDefaultAddress(target);
    return { target, receivers: this.addresses.audience(target).people.map(personRef) };
  }

  canSpeak(target: import("@compforge/aide-plugin").Address): boolean { return this.addresses.canSpeak(target); }

  private async outputAudience(ref: AddressRef) {
    const address = this.addresses.read(ref);
    try { assertChannelDelivery(address.spec.endpoint, enabledLarkApps(this.options.config?.channels ?? {})); }
    catch { return { people: [], private: false, unavailable: "Destination Channel is disabled or unavailable" }; }
    return this.addresses.audience(ref);
  }

  private async initializePeople() {
    for (const config of this.requirementConnections) {
      if (!config.me) continue;
      const account = await this.connectors.requirements.identity(config.source);
      this.meMarks.identities.push({ provider: account.provider, scope: account.scope, id: config.me.userKey });
    }
    const result = await this.persons.initialize();
    const localMe = await this.persons.findIdentity(LOCAL_ME);
    if (localMe) this.addresses.observe(webAddress("me"), [personRef(localMe)], { muted: false, type: "web", name: "Me 的 Web 收件处" });
    for (const identity of this.meMarks.identities) {
      if (identity.provider !== "lark") continue;
      const me = await this.persons.findIdentity(identity);
      if (me) this.addresses.observe(larkPersonAddress(identity.scope, identity.id), [personRef(me)], { muted: false, type: "direct", name: "Me" });
    }
    if (result.conflict) this.log.error(result.conflict, "Me consolidation deferred; original Persons preserved");
    this.log.info({ meIdentities: this.meMarks.identities.length, mePersons: (await this.persons.list()).filter(p => p.isMe).length, merged: result.merged }, "Me identities reconciled");
  }
  start(): Promise<void> {
    return this.starting ??= Promise.resolve().then(async () => {
      await this.initializePeople();
      await this.personal.start();
    });
  }
  async settled(): Promise<void> {
    await this.start();
    for (;;) {
      const before = JSON.stringify([this.inputs.list(), this.topics.list()]);
      await this.personal.settled();
      // Fixture publications can bypass controller watches; drain independently without replacing runtime retry scheduling.
      await Promise.allSettled(this.outputStore.list().filter(output => output.status.phase === "pending")
        .map(output => this.delivery.reconcile(output.metadata.name)));
      const after = JSON.stringify([this.inputs.list(), this.topics.list()]);
      if (before === after) break;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.personal.close();
    await this.ownedConnectors?.close();
    this.listeners.clear();
    this.unsubscribeResources();
    this.unsubscribeOutputs();
  }
}
