import type { Address } from "@compforge/aide-plugin";
import { OutputStore } from "./host/output/store.ts";
import { outputView } from "./output.ts";
import { personMessages } from "../plugins/personal/person/messages.ts";
import { CHANNELS, type ChannelDefinition } from "./channel/definition.ts";
import { SOURCES } from "../plugins/personal/source/definition.ts";
import type { InputSpec, SourceDefinition } from "@compforge/aide-plugin";
import { resolve } from "node:path";
import { LOCAL_ME, type Me } from "../plugins/personal/person/model.ts";
import personalDefinitions from "../plugins/personal/definitions.ts";
import { openPersonCatalog } from "../plugins/personal/person/catalog.ts";
import type { Logger } from "pino";
import type { ConnectorClient } from "@compforge/aide-plugin";
import { Personal } from "../plugins/personal/aide.ts";
import { environmentSources, ENVIRONMENT_SESSION } from "../plugins/personal/source/environment/config.ts";
import { InputStore } from "./host/input/store.ts";
import { resolveEnvironmentConfig } from "../connectors/environments/config.ts";
import { requirementWatches, validateWatchScopes } from "../plugins/personal/source/requirement/config.ts";
import { parsePersonalConfig } from "../plugins/personal/config.ts";
import { messageWatch, MESSAGE_SESSION } from "../plugins/personal/source/message/config.ts";
import { chiefTarget } from "../plugins/personal/chief-model.ts";
import { loadMeegoRequirementConfigs } from "../connectors/requirements/meego.ts";
import { Connectors } from "../connectors/index.ts";
import type { AideConfig, DefaultHarness } from "./config.ts";
import { harnessSessionKey } from "./host/harness/registry.ts";
import { CoreSession, type CoreControllerOptions } from "./host/core/index.ts";
import { SessionStore } from "./host/store/store.ts";
import { PluginInstanceStore } from "./host/plugin/instance.ts";
import { PluginSupervisor } from "./host/plugin/runner/index.ts";
import { IncomingSchema, type Incoming } from "./channel/message.ts";

export interface AideOptions {
  cwd: string; timezone: string; config?: AideConfig; connectors?: ConnectorClient;
  defaultTarget: Readonly<{ id: string; harness: DefaultHarness; model?: string }>;
  createAdapter: CoreControllerOptions["createAdapter"];
}

/**
 * @spec Channel/Source owns stable Session identity; Core owns its persisted execution and lease.
 * @why Restore every Session at startup so autonomous work does not depend on another user message.
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

  private readonly storage: SessionStore;
  private readonly defaultTarget: AideOptions["defaultTarget"];
  private readonly active = new Map<string, Personal>();
  private readonly listeners = new Set<() => void>();
  private readonly watches: ReturnType<typeof requirementWatches>;
  private readonly environmentSources: ReturnType<typeof environmentSources>;
  private readonly messageSource: ReturnType<typeof messageWatch>;
  private readonly inputs: InputStore;
  readonly outputStore: OutputStore;
  private readonly unsubscribeOutputs: () => void;
  private readonly unsubscribeResources: () => void;
  private readonly connectors: ConnectorClient;
  private readonly meMarks: Me;
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
    this.inputs = new InputStore(home);
    this.outputStore = new OutputStore(home);
    this.unsubscribeOutputs = this.outputStore.subscribe(() => this.notify());
    this.inputs.storage.configure(config?.resources);
    this.inputs.storage.register("personal", personalDefinitions);
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
    this.storage = new SessionStore(home);
    this.catalog = openPersonCatalog(home, this.meMarks, log, () => this.notify());
    this.connectors = config?.connectors.lark?.appId ? { requirements: connectors.requirements, forges: connectors.forges,
      environments: connectors.environments, describe: () => connectors.describe(),
      messages: personMessages(connectors.messages, this.persons, config.connectors.lark.appId) } : connectors;
    for (const meta of this.storage.listSessions()) this.session(meta.aideSessionId);
    for (const watch of this.watches) this.session(watch.sessionId);
    if (this.environmentSources.length) this.session(ENVIRONMENT_SESSION);
    if (this.messageSource) this.session(MESSAGE_SESSION);

  }

  sessions(): readonly Personal[] { return [...this.active.values()]; }

  /** Opening a page never creates a Session; only an input or explicit work request does. */
  findConversation(conversationId: string): Personal | undefined {
    return this.sessions().find((scope) => scope.conversationIds().includes(conversationId));
  }

  session(id: string): Personal {
    if (this.closed) throw new Error("Aide is shutting down");
    const existing = this.active.get(id);
    if (existing) return existing;
    const previous = this.storage.listSessions().find((meta) => meta.aideSessionId === id);
    const session = previous ? this.storage.openSession(id) : this.storage.createSession({ id, cwd: this.options.cwd, title: id });
    const connectors = this.connectors;
    const { id: targetId, harness, model } = this.defaultTarget;
    const targets = [{ id: targetId, harness }];
    session.setHarnessTarget(targetId, { harnessTargetId: targetId, harness, ...(model ? { model } : {}) });
    const instances = new PluginInstanceStore({ session });
    if (!instances.list().some((item) => item.pluginInstanceId === "personal")) {
      instances.create({ pluginInstanceId: "personal", pluginId: "aide.personal", packageVersion: "0.1.0", marketplace: "builtin" });
    }
    instances.replaceConfig("personal", { ...((parsePersonalConfig(this.options.config?.plugins.personal).conversation) ? { conversation: parsePersonalConfig(this.options.config?.plugins.personal).conversation } : {}), watches: this.watches.filter((watch) => watch.sessionId === id),
      environmentSources: id === ENVIRONMENT_SESSION ? this.environmentSources : [],
      ...(id === MESSAGE_SESSION && this.messageSource ? { messageSource: this.messageSource } : {}) });
    const packages = new Map([["aide.personal@0.1.0", new URL("../plugins/personal/plugin.ts", import.meta.url).href]]);
    let application: Personal;
    const core = new CoreSession({ session,
      controller: { mentionBudgetChars: 0, createAdapter: this.options.createAdapter, resolveTarget: (id) => targets.find((item) => item.id === id) },
      plugins: { instances, connectors, harnessTargets: targets, inputs: this.inputs, outputs: this.outputStore,
        resourceDirectory: { sessions: () => [...this.active.keys()], shared: (pluginId) => {
          if (pluginId !== "personal") throw new Error(`Unknown shared plugin: ${pluginId}`);
          return this.catalog.client;
        }, client: (sessionId, pluginId) => {
          const scope = this.active.get(sessionId); if (!scope) throw new Error(`Unknown Session: ${sessionId}`);
          return scope.plugins.resourceClient(pluginId);
        }, ensureSession: async (sessionId) => { await this.session(sessionId).start(); } },
        onResourceChange: (change) => application?.conversations.changed(change),
        say: (context, text, options) => {
          if (!context.conversationId) throw new Error("Personal say requires Conversation context");
          return application.conversations.say(context.conversationId, context.inputId, text, context.executionId, options);
        }, selectedHarnessTargetId: () => targetId,
        harnessInvocationGate: () => "auto_approve", pluginSupervisor: new PluginSupervisor(),
        loadPackageEntry: async (pluginId, version) => {
          const entryUrl = packages.get(`${pluginId}@${version}`);
          if (!entryUrl) throw new Error(`Plugin package is not installed: ${pluginId}@${version}`);
          return { pluginId, version, entryUrl, resourcesUrl: new URL("../plugins/personal/definitions.ts", import.meta.url).href };
        },
        onRunnerFailure: ({ error }) => {
          this.log.error({ err: error, sessionId: id }, "Plugin Runner stopped");
          void application.recoverInterrupted().catch((err) => this.log.error({ err, sessionId: id }, "Recovery failed"));
        },
      },
    });
    // CoreSession has acquired the lease before changing execution metadata.
    // @spec A default Harness change preserves Aide history but cannot reuse another provider's native binding.
    const sessionKey = harnessSessionKey(harness);
    const incompatible = Object.values(session.meta.lanes).filter((lane) =>
      lane.harnessSessions[targetId] && lane.harnessSessions[targetId].harness !== sessionKey);
    if (incompatible.length) {
      const lanes = { ...session.meta.lanes };
      for (const lane of incompatible) {
        const { [targetId]: _previous, ...harnessSessions } = lane.harnessSessions;
        lanes[lane.laneId] = { ...lane, harnessSessions };
      }
      // Clear the compatibility projection too; normalization otherwise restores the removed main-Lane binding.
      session.updateMeta({ lanes, harnessSessions: {} });
      this.log.info({ sessionId: id, harness, harnessTargetId: targetId, lanes: incompatible.length },
        "Default Harness changed; cleared incompatible native bindings");
    }
    const cwd = resolve(this.options.cwd);
    if (session.meta.cwd !== cwd) {
      // Native providers can bind history to cwd. Keep Aide facts, but start fresh provider contexts.
      session.updateMeta({ cwd, lanes: Object.fromEntries(Object.entries(session.meta.lanes)
        .map(([key, lane]) => [key, { ...lane, harnessSessions: Object.fromEntries(Object.entries(lane.harnessSessions)
          .filter(([, binding]) => binding.contextAfterSeq !== undefined)
          .map(([target, binding]) => [target, { harness: binding.harness, contextAfterSeq: binding.contextAfterSeq }])) }])) });
      this.log.info({ sessionId: id, previousCwd: previous?.cwd, cwd }, "Execution directory changed; cleared native Harness bindings");
    }
    application = new Personal({ timezone: this.options.timezone, persons: this.persons, me: this.meMarks,
      conversation: parsePersonalConfig(this.options.config?.plugins.personal).conversation }, this.log.child({ sessionId: id }),
      { core, session, connectors, targets, inputs: this.inputs, outputs: this.outputStore });
    this.active.set(id, application);
    core.subscribe(() => this.notify());
    application.conversations.subscribe(() => this.notify());
    this.log.info({ sessionId: id, resumed: Boolean(previous) }, "Opened Aide session");
    if (this.starting) void application.start().catch((err) => this.log.error({ err, sessionId: id }, "Session startup failed"));
    return application;
  }

  private async claimConversation(scope: Personal, conversationId: string, address?: Address): Promise<void> {
    const owner = this.findConversation(conversationId);
    if (owner && owner !== scope) throw new Error(`Conversation ${conversationId} belongs to Session ${owner.id}`);
    if (!scope.conversations.get(conversationId)) await scope.conversations.ensure(conversationId, address);
  }

  async receive(raw: unknown) {
    const input = IncomingSchema.parse(raw);
    this.inputDefinition({ origin: "channel", originId: input.channelId });
    if (input.source.channelId !== input.channelId) throw new Error("Channel input address belongs to a different Channel");
    const scope = this.session(input.sessionId);
    await this.claimConversation(scope, input.sessionId, input.source);
    await this.start();
    return scope.receive(input);
  }

  async event(input: Omit<Incoming, "channelId" | "source"> & { name: string; conversationId?: string }): Promise<number> {
    const scope = this.session(input.sessionId);
    await this.claimConversation(scope, input.sessionId);
    await this.start(); await scope.start();
    return scope.event({ ...input, conversationId: input.conversationId ?? input.sessionId });
  }

  work(conversationId: string) {
    const scope = this.findConversation(conversationId) ?? this.session(conversationId);
    return scope.work(conversationId);
  }

  chiefSession(targetId: string, config: Parameters<Personal["chiefSession"]>[1]) {
    const scope = this.sessions().find((item) => item.conversationIds().some((id) => chiefTarget(id) === targetId));
    if (!scope) throw new Error(`Unknown Chief target: ${targetId}`);
    return scope.chiefSession(targetId, config);
  }

  async outputDelivered(outputId: string) { if (this.outputStore.get(outputId)) this.outputStore.delivered(outputId); }
  async outputSending(outputId: string) { if (this.outputStore.get(outputId)) this.outputStore.begin(outputId); }
  async outputRetry(outputId: string, error: string, nextAttemptAt: string) { if (this.outputStore.get(outputId)) this.outputStore.retry(outputId, error, nextAttemptAt); }
  outputs() { return this.outputStore.list().map(outputView).sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)); }

  works() { return this.sessions().flatMap((scope) => scope.works()); }
  questions() { return this.sessions().flatMap((scope) => scope.questions()); }
  invocations() { return this.sessions().flatMap((scope) => scope.invocations()); }
  conversationIds() { return this.sessions().flatMap((scope) => scope.conversationIds()); }
  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { for (const listener of this.listeners) listener(); }
  async deleteConversation(conversationId: string, revision: number, uid: string): Promise<import("../plugins/personal/conversation/model.ts").ConversationDeletion> {
    const scope = this.findConversation(conversationId);
    if (!scope) return { deleted: false, reason: "missing" };
    const result = await scope.deleteConversation(conversationId, revision, uid);
    if (result.deleted) this.notify();
    return result;
  }

  /** @spec At most one default contact across Sessions. Clear before setting; interruption may leave none, never two.
   * @link docs/plugin/personal.md
   */
  setDefaultConversation(conversationId: string, enabled: boolean): Promise<void> {
    const change = this.defaultSelection.then(async () => {
      const target = this.findConversation(conversationId);
      const resource = target?.conversations.resource(conversationId);
      if (!target || !resource || resource.metadata.deletionTimestamp) {
        throw new Error("Conversation does not exist");
      }
      if (enabled) {
        for (const scope of this.sessions()) {
          for (const conversation of scope.conversations.list()) {
            if (conversation.default && conversation.id !== conversationId && !scope.conversations.resource(conversation.id)?.metadata.deletionTimestamp) await scope.conversations.setDefault(conversation.id, false);
          }
        }
      }
      await target.conversations.setDefault(conversationId, enabled);
      this.log.info({ conversationId, sessionId: target.id, enabled }, "Default conversation configured");
      this.notify();
    });
    this.defaultSelection = change.catch((err) => { this.log.error({ err, conversationId }, "Default conversation selection failed"); });
    return change;
  }

  async setConversationTrigger(conversationId: string, enabled: boolean) {
    const scope = this.findConversation(conversationId);
    if (!scope) throw new Error("Conversation does not exist");
    const trigger = await scope.conversations.setTriggerEnabled(conversationId, enabled);
    this.log.info({ sessionId: scope.id, conversationId, ...trigger }, "Conversation trigger configured");
    this.notify();
    return trigger;
  }

  start(): Promise<void> {
    return this.starting ??= this.persons.initialize().then(() => Promise.all(this.sessions().map((scope) => scope.start()))).then(() => {});
  }
  async settled(): Promise<void> {
    await this.start();
    for (;;) {
      const before = JSON.stringify([this.inputs.list(), this.sessions().flatMap((s) => s.conversations.list())]);
      await Promise.all(this.sessions().map((scope) => scope.settled()));
      const after = JSON.stringify([this.inputs.list(), this.sessions().flatMap((s) => s.conversations.list())]);
      if (before === after) break;
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.defaultSelection;
    await Promise.all(this.sessions().map((scope) => scope.close()));
    this.listeners.clear();
    this.unsubscribeResources();
    this.unsubscribeOutputs();
  }
}
