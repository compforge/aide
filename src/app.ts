import { initialConversationName } from "../plugins/personal/conversation/model.ts";
import { ROUTE_TARGET } from "../plugins/personal/route/model.ts";
import { personalExecution } from "../plugins/personal/execution-context.ts";
import { ResourceStorage } from "./host/resource/storage.ts";
import { SayInputSchema } from "../plugins/personal/output/action.ts";
import { personalAdmission } from "../plugins/personal/admission.ts";
import { OutputStore } from "../plugins/personal/output/store.ts";
import { outputView } from "./output.ts";
import { personRequirements } from "../plugins/personal/person/requirements.ts";
import { requirementOutputs } from "../plugins/personal/output/requirements.ts";
import { personMessages } from "../plugins/personal/person/messages.ts";
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
  defaultTarget: Readonly<{ id: string; harness: DefaultHarness; model?: string }>;
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
    const definition = this.inputDefinitions.get(`${origin.origin}:${origin.originId}`);
    if (!definition) throw new Error(`Unknown input definition: ${origin.origin}:${origin.originId}`);
    return definition;
  }

  readonly runtime: ApplicationRuntime;
  readonly personal: Personal;
  private readonly defaultTarget: AideOptions["defaultTarget"];
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
  private defaultSelection: Promise<void> = Promise.resolve();

  constructor(home: string, private readonly options: AideOptions, private readonly log: Logger) {
    this.defaultTarget = Object.freeze({ ...options.defaultTarget });
    const config = options.config;
    const { sources } = parsePersonalConfig(config?.plugins.personal);
    this.meMarks = { identities: [LOCAL_ME, ...(config?.connectors.lark?.me ?? []).map((i) => ({ provider: "lark", scope: i.appId, id: i.openId }))] };
    this.watches = requirementWatches(sources.requirements);
    this.messageSource = messageWatch(sources.lark, config?.connectors.lark, this.meMarks);
    const environments = resolveEnvironmentConfig(config?.connectors.environments);
    this.environmentSources = environmentSources(sources.environments, environments);
    const storage = ResourceStorage.open(home);
    storage.configure(config?.resources);
    storage.register("personal", personalDefinitions);
    this.inputs = new InputStore(home);
    this.outputStore = new OutputStore(home);
    this.unsubscribeOutputs = this.outputStore.subscribe(() => this.notify());
    this.inputs.storage.onRetentionError = (resource, error) => this.log.error({ err: error, kind: resource.kind, uid: resource.metadata.uid }, "Resource retention decision failed; preserved resource");
    this.unsubscribeResources = this.inputs.storage.subscribe((scope, resource) => { this.log.info({ scope, kind: resource.kind, uid: resource.metadata.uid }, "Resource reclaimed"); });
    validateWatchScopes(this.watches, loadMeegoRequirementConfigs(config?.connectors ?? {}));
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
      instances: [{ pluginInstanceId: "personal", pluginId: "aide.personal", packageVersion: "0.1.0", marketplace: "builtin", config: JSON.parse(JSON.stringify({ route: parsePersonalConfig(config?.plugins.personal).route, conversation: parsePersonalConfig(config?.plugins.personal).conversation, watches: this.watches,
        environmentSources: this.environmentSources, ...(this.messageSource ? { messageSource: this.messageSource } : {}) })) }],
      harness: { targets: [{ ...this.defaultTarget }, { id: ROUTE_TARGET, harness: "route" }],
        defaultTargetId: this.defaultTarget.id, historyBudgetChars: 0, createAdapter: options.createAdapter },
      plugins: { connectors: this.connectors, resourceAdmissions: { personal: personalAdmission(this.inputs, this.outputStore) },
        onResourceChange: (change) => { personal?.conversations.changed(change); this.notify(); },
        actions: { "personal/say": (context, raw) => {
          const input = SayInputSchema.parse(raw);
          const text = input.text;
          const association = personalExecution(context);
          if (!association.conversationId) throw new Error("Personal say requires Conversation context");
          return this.personal.conversations.say(association.conversationId, association.inputId, text, context.executionId, input);
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
    this.personal = personal = new Personal({ timezone: options.timezone, persons: this.persons, me: this.meMarks,
      conversation: parsePersonalConfig(config?.plugins.personal).conversation }, log,
      { runtime: this.runtime, connectors: this.connectors, inputs: this.inputs, outputs: this.outputStore });
    this.runtime.subscribe(() => this.notify());
    this.personal.conversations.subscribe(() => this.notify());
  }

  get conversations() { return this.personal.conversations; }

  async receive(raw: unknown) {
    const input = IncomingSchema.parse(raw);
    this.inputDefinition({ origin: "channel", originId: input.channelId });
    if (input.source.channelId !== input.channelId) throw new Error("Channel input address belongs to a different Channel");
    const scope = this.personal;
    await this.conversations.ensure(input.sessionId, input.source, initialConversationName(input.text));
    await this.start();
    return scope.receive(input);
  }

  async event(input: Omit<Incoming, "channelId" | "source"> & { name: string; conversationId?: string }): Promise<number> {
    const scope = this.personal;
    await this.conversations.ensure(input.sessionId);
    await this.start(); await scope.start();
    return scope.event({ ...input, conversationId: input.conversationId ?? input.sessionId });
  }

  work(conversationId: string) { return this.personal.work(conversationId); }

  chiefSession(targetId: string, config: Parameters<Personal["chiefSession"]>[1]) {
    return this.personal.chiefSession(targetId, config);
  }

  async outputDelivered(outputId: string) { if (this.outputStore.get(outputId)) this.outputStore.delivered(outputId); }
  async outputSending(outputId: string) { if (this.outputStore.get(outputId)) this.outputStore.begin(outputId); }
  async outputRetry(outputId: string, error: string, nextAttemptAt: string) { if (this.outputStore.get(outputId)) this.outputStore.retry(outputId, error, nextAttemptAt); }
  outputs() { return this.outputStore.list().map(outputView).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)); }

  works() { return this.personal.works(); }
  invocations() { return this.personal.invocations(); }
  conversationIds() { return this.personal.conversationIds(); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { for (const listener of this.listeners) listener(); }
  async deleteConversation(conversationId: string, revision: number, uid: string): Promise<import("../plugins/personal/conversation/model.ts").ConversationDeletion> {
    const scope = this.personal;
    const result = await scope.deleteConversation(conversationId, revision, uid);
    if (result.deleted) this.notify();
    return result;
  }

  /** @spec Default selection is atomic and storage enforces uniqueness against concurrent Route fallback creation.
   * @link docs/plugin/personal.md
   */
  setDefaultConversation(conversationId: string, enabled: boolean): Promise<void> {
    const change = this.defaultSelection.then(async () => {
      for (let attempt = 0; ; attempt++) {
        const resource = this.conversations.resource(conversationId);
        if (!resource || resource.metadata.deletionTimestamp) throw new Error("Conversation does not exist");
        const previous = enabled ? this.conversations.list().filter(c => c.default && c.id !== conversationId)
          .map(c => this.conversations.resource(c.id)!) : [];
        try {
          await this.runtime.plugins.resourceClient("personal").commit([
            ...previous.map(c => ({ operation: "replace" as const, resource: c, spec: { ...c.spec, default: false }, status: c.status })),
            { operation: "replace", resource, spec: { ...resource.spec, default: enabled }, status: resource.status },
          ]);
          break;
        } catch (error) {
          if (attempt >= 8 || !/version conflict|Default Conversation already exists/.test(String(error))) throw error;
        }
      }
      this.log.info({ conversationId, enabled }, "Default conversation configured");
      this.notify();
    });
    this.defaultSelection = change.catch((err) => { this.log.error({ err, conversationId }, "Default conversation selection failed"); });
    return change;
  }

  async setConversationTrigger(conversationId: string, enabled: boolean) {
    const scope = this.personal;
    if (!this.conversations.get(conversationId)) throw new Error("Conversation does not exist");
    const trigger = await scope.conversations.setTriggerEnabled(conversationId, enabled);
    this.log.info({ conversationId, ...trigger }, "Conversation trigger configured");
    this.notify();
    return trigger;
  }

  private async initializePeople() {
    for (const config of loadMeegoRequirementConfigs(this.options.config?.connectors ?? {})) {
      if (!config.me) continue;
      const account = await this.connectors.requirements.identity(config.source);
      this.meMarks.identities.push({ provider: account.provider, scope: account.scope, id: config.me.userKey });
    }
    await this.persons.initialize();
  }
  start(): Promise<void> {
    return this.starting ??= this.initializePeople().then(() => this.personal.start());
  }
  async settled(): Promise<void> {
    await this.start();
    for (;;) {
      const before = JSON.stringify([this.inputs.list(), this.conversations.list()]);
      await this.personal.settled();
      const after = JSON.stringify([this.inputs.list(), this.conversations.list()]);
      if (before === after) break;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.defaultSelection;
    await this.personal.close();
    this.listeners.clear();
    this.unsubscribeResources();
    this.unsubscribeOutputs();
  }
}
