import { iconFor } from "@compforge/aide-plugin";
import { initialTopicName } from "../plugins/personal/topic/model.ts";
import { ROUTE_HARNESS } from "../plugins/personal/route/model.ts";
import { personalExecution } from "../plugins/personal/execution-context.ts";
import { ResourceStorage } from "./host/resource/storage.ts";
import { SayInputSchema } from "../plugins/personal/output/action.ts";
import { personalAdmission } from "../plugins/personal/admission.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { outputView } from "./output.ts";
import { personRequirements } from "../plugins/personal/person/requirements.ts";
import { requirementOutputs } from "../plugins/personal/output/requirements.ts";
import { personMessages } from "../plugins/personal/person/messages.ts";
import { reconcileChannelOutputs } from "./channel/delivery.ts";
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
import { resolveEnvironmentConfig } from "../connectors/environments/config.ts";
import { requirementWatches, validateWatchScopes } from "../plugins/personal/source/requirement/config.ts";
import { parsePersonalConfig } from "../plugins/personal/config.ts";
import { messageWatch } from "../plugins/personal/source/message/config.ts";
import { loadMeegoRequirementConfigs } from "../connectors/requirements/meego.ts";
import { Connectors } from "../connectors/index.ts";
import type { AideConfig, DefaultHarness } from "./config.ts";
import { type ExecutionOptions } from "./host/runtime/execution.ts";
import { ApplicationRuntime } from "./host/runtime/index.ts";
import { PluginSupervisor } from "./host/plugin/runner/index.ts";
import { IncomingSchema, type Incoming } from "./channel/message.ts";

export interface AideOptions {
  cwd: string; timezone: string; config?: AideConfig; connectors?: ConnectorClient;
  defaultHarnessConfig: Readonly<{ id: string; harness: DefaultHarness; model?: string }>;
  createAdapter: ExecutionOptions["createAdapter"];
}

/**
 * @spec The application composes one generic runtime with the Personal domain plugin.
 * @why Transport topics select business context, never a separate scheduler or resource store.
 * @link docs/kernel.md
 */
export class Aide {
  private readonly inputDefinitions = new Map<string, ChannelDefinition | SourceDefinition>([
    ...Object.values(CHANNELS).map((definition) => [`channel:${definition.id}`, definition] as const),
    ...Object.values(SOURCES).map((definition) => [`source:${definition.id}`, definition] as const),
  ]);
  inputDefinition(origin: Pick<InputSpec, "origin" | "originId">) {
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
  private readonly unsubscribeOutputs: () => void;
  private readonly unsubscribeResources: () => void;
  private readonly connectors: ConnectorClient;
  private readonly meMarks: Me & { identities: PersonIdentity[] };
  readonly catalog: ReturnType<typeof openPersonCatalog>;
  get persons() { return this.catalog.persons; }
  private starting?: Promise<void>;
  private closed = false;

  constructor(home: string, private readonly options: AideOptions, private readonly log: Logger) {
    this.defaultHarnessConfig = Object.freeze({ ...options.defaultHarnessConfig });
    const config = options.config;
    const { sources } = parsePersonalConfig(config?.plugins.personal);
    const connectorMe = { identities: (config?.connectors.lark?.me ?? []).map(i => ({ provider: "lark", scope: i.appId, id: i.openId })) };
    const channelMe = { identities: [LOCAL_ME, ...Object.values(config?.channels ?? {}).flatMap(c => c.me ? [{ provider: "lark", scope: c.appId, id: c.me.openId }] : [])] };
    this.meMarks = { identities: [...channelMe.identities, ...connectorMe.identities] };
    this.meMarks.identities = [...new Map(this.meMarks.identities.map(identity => [JSON.stringify(identity), identity])).values()];
    const requirements = loadMeegoRequirementConfigs(config?.connectors ?? {});
    this.watches = requirementWatches(sources.requirements).map(watch => {
      const me = requirements.find(c => c.source === watch.source)?.me;
      return { ...watch, ...(me ? { me } : {}) };
    });
    this.messageSource = messageWatch(sources.lark, config?.connectors.lark, connectorMe);
    const environments = resolveEnvironmentConfig(config?.connectors.environments);
    this.environmentSources = environmentSources(sources.environments, environments);
    const storage = ResourceStorage.open(home);
    storage.configure(config?.resources);
    storage.register("personal", personalDefinitions);
    this.inputs = new InputStore(home);
    this.outputStore = new OutputStore(home, target => assertChannelDelivery(target, enabledLarkApps(config?.channels ?? {})));
    this.unsubscribeOutputs = this.outputStore.subscribe(() => this.notify());
    this.inputs.storage.onRetentionError = (resource, error) => this.log.error({ err: error, kind: resource.kind, uid: resource.metadata.uid }, "Resource retention decision failed; preserved resource");
    this.unsubscribeResources = this.inputs.storage.subscribe((scope, resource) => { this.log.info({ scope, kind: resource.kind, uid: resource.metadata.uid }, "Resource reclaimed"); });
    validateWatchScopes(this.watches, requirements);
    this.log.info({
      meIdentities: this.meMarks.identities.length,
      environments: this.environmentSources.map(({ environment, namespace, intervalMs }) => ({ environment, namespace, intervalMs })),
      requirements: this.watches.map(({ id, source, intervalMs }) => ({ id, connector: source, intervalMs })),
      lark: this.messageSource ? { intervalMs: this.messageSource.intervalMs, scenarios: ["direct", "mention"] } : null,
    }, "Personal observation sources configured");
    const connectors = options.connectors ?? Connectors.fromConfig(config?.connectors ?? {});
    this.catalog = openPersonCatalog(home, this.meMarks, log, () => this.notify());
    this.connectors = { requirements: requirementOutputs(personRequirements(connectors.requirements, this.persons), this.outputStore), forges: connectors.forges,
      environments: connectors.environments, describe: () => connectors.describe(),
      messages: config?.connectors.lark?.appId ? personMessages(connectors.messages, this.persons, config.connectors.lark.appId) : connectors.messages };
    let personal: Personal | undefined;
    this.runtime = new ApplicationRuntime(home, {
      cwd: options.cwd,
      instances: [{ pluginInstanceId: "personal", pluginId: "aide.personal", packageVersion: "0.1.0", marketplace: "builtin", config: JSON.parse(JSON.stringify({ weave: parsePersonalConfig(config?.plugins.personal).weave, route: parsePersonalConfig(config?.plugins.personal).route, topic: parsePersonalConfig(config?.plugins.personal).topic, task: parsePersonalConfig(config?.plugins.personal).task, routine: parsePersonalConfig(config?.plugins.personal).routine, watches: this.watches,
        environmentSources: this.environmentSources, ...(this.messageSource ? { messageSource: this.messageSource } : {}) })) }],
      harness: { harnesses: [{ ...this.defaultHarnessConfig }, { id: "weave", harness: "weave" }, { id: ROUTE_HARNESS, harness: "route" }, { id: "chief", harness: "chief" }, { id: "task", harness: "task" }, { id: "routine", harness: "routine" }],
        defaultHarness: this.defaultHarnessConfig.id, createAdapter: options.createAdapter },
      plugins: { connectors: this.connectors, resourceAdmissions: { personal: personalAdmission(this.inputs, this.outputStore) },
        onResourceChange: (change) => { personal?.topics.changed(change); this.notify(); },
        actions: { "personal/submit_input": (context, input) => this.personal.submitInput(context, input), "personal/say": (context, raw) => {
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
        }, onRunnerFailure: ({ error }) => {
          this.log.error({ err: error }, "Personal Runner stopped");
          void personal?.recoverInterrupted().catch((err) => this.log.error({ err }, "Recovery failed"));
        },
      },
    });
    this.personal = personal = new Personal({ timezone: options.timezone, persons: this.persons, channelMe,
      channels: [{ id: "web", provider: "local", default: (config?.defaultChannel ?? "web") === "web" },
        ...Object.entries(config?.channels ?? {}).filter(([, c]) => c.enabled).map(([id, c]) => ({ id, provider: "lark", scope: c.appId, default: config?.defaultChannel === id }))],
      topic: parsePersonalConfig(config?.plugins.personal).topic, weave: parsePersonalConfig(config?.plugins.personal).weave }, log,
      { runtime: this.runtime, connectors: this.connectors, inputs: this.inputs, outputs: this.outputStore, resolveContact: (topicId, to, channelId, target) => this.resolveContact(topicId, to, channelId, target) });
    this.runtime.subscribe(() => this.notify());
    this.personal.topics.subscribe(() => this.notify());
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

  async outputDelivered(outputId: string) { if (this.outputStore.get(outputId)) this.outputStore.delivered(outputId); }
  async outputSending(outputId: string) { if (this.outputStore.get(outputId)) this.outputStore.begin(outputId); }
  async outputRetry(outputId: string, error: string, nextAttemptAt: string) { if (this.outputStore.get(outputId)) this.outputStore.retry(outputId, error, nextAttemptAt); }
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

  async setTopicTrigger(topicId: string, enabled: boolean) {
    const scope = this.personal;
    if (!this.topics.get(topicId)) throw new Error("Topic does not exist");
    const trigger = await scope.topics.setTriggerEnabled(topicId, enabled);
    this.log.info({ topicId, ...trigger }, "Topic trigger configured");
    this.notify();
    return trigger;
  }

  /** @spec Resolve recipients in the selected Channel scope; Aide remains the sender. Default Me contact never relies on Topic address.
   * @link docs/channel/README.md
   */
  private async resolveContact(topicId: string, to?: import("../plugins/personal/output/model.ts").SayInput["to"], channelId?: string, target?: import("@compforge/aide-plugin").Address) {
    const explicitPerson = to && "personId" in to ? await this.persons.read(to.personId, to.uid) : undefined;
    if (explicitPerson && !channelId && !target) throw new Error("Contacting a Person requires channelId or an explicit target");
    if (target) {
      const person = explicitPerson ?? (await this.persons.list()).find(p => p.isMe);
      if (!person) throw new Error("Me is not configured");
      return { target, receivers: [personRef(person)] };
    }
    const id = channelId ?? this.options.config?.defaultChannel ?? "web";
    let identity = LOCAL_ME;
    if (id !== "web") {
      const channel = this.options.config?.channels[id];
      if (!channel?.enabled) throw new Error(`Channel is unavailable: ${id}`);
      if (explicitPerson) {
        const identities = explicitPerson.spec.identities.filter(i => i.provider === "lark" && i.scope === channel.appId);
        if (identities.length !== 1) throw new Error(`Person ${explicitPerson.metadata.name} needs one Lark identity in Channel ${id}`);
        identity = identities[0]!;
      } else {
        if (!channel.me) throw new Error(`Default Channel ${id} needs Me's identity in app ${channel.appId}; configure channels.${id}.me`);
        identity = { provider: "lark", scope: channel.appId, id: channel.me.openId };
      }
    } else if (explicitPerson && !explicitPerson.isMe) throw new Error("Web Channel only contacts Me; specify another Channel or an explicit target");
    const person = explicitPerson ?? await this.persons.findIdentity(identity);
    if (!person) throw new Error(`Default Channel ${id} has no Person for its configured Me identity`);
    return { target: id === "web" ? webAddress(topicId) : larkPersonAddress(identity.scope, identity.id), receivers: [personRef(person)] };
  }

  private async initializePeople() {
    for (const config of loadMeegoRequirementConfigs(this.options.config?.connectors ?? {})) {
      if (!config.me) continue;
      const account = await this.connectors.requirements.identity(config.source);
      this.meMarks.identities.push({ provider: account.provider, scope: account.scope, id: config.me.userKey });
    }
    const result = await this.persons.initialize();
    if (result.conflict) this.log.error(result.conflict, "Me consolidation deferred; original Persons preserved");
    this.log.info({ meIdentities: this.meMarks.identities.length, mePersons: (await this.persons.list()).filter(p => p.isMe).length, merged: result.merged }, "Me identities reconciled");
  }
  start(): Promise<void> {
    return this.starting ??= Promise.resolve().then(async () => {
      reconcileChannelOutputs(this.outputStore, enabledLarkApps(this.options.config?.channels ?? {}), this.log);
      await this.initializePeople();
      await this.personal.start();
    });
  }
  async settled(): Promise<void> {
    await this.start();
    for (;;) {
      const before = JSON.stringify([this.inputs.list(), this.topics.list()]);
      await this.personal.settled();
      const after = JSON.stringify([this.inputs.list(), this.topics.list()]);
      if (before === after) break;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.personal.close();
    this.listeners.clear();
    this.unsubscribeResources();
    this.unsubscribeOutputs();
  }
}
