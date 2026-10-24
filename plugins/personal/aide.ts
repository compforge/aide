import { identityBackground } from "../../agents/personal.ts";
import { weavePolicy } from "./weave/config.ts";
import { topicTools } from "./topic/tools.ts";
import { topicSubtree } from "./topic/tree.ts";
import { weaveSession } from "./weave/agent.ts";
import { WEAVE_TYPE } from "./weave/model.ts";
import { inputPreview } from "./input/prompt.ts";
import { topicCandidates, contextPage } from "./background.ts";
import { Background as TopicBackground } from "./topic/background.ts";
import { Background as RouteBackground } from "./route/background.ts";
import { routineSession } from "./routine/agent.ts";
import { taskSession } from "./task/agent.ts";
import type { PiConfig } from "../../src/host/harness/pi/config.ts";
import { summarizeTopic } from "./topic/state.ts";
import { personalExecution } from "./execution-context.ts";
import { say } from "./output/action.ts";
import type { OutputStore } from "./output/store.ts";
import { createRouteAgent } from "../../agents/route/agent.ts";
import { assessInput, type AssessInput } from "./topic/assess.ts";
import { attemptOf, attemptPatch, resourceRef, changeAttempt } from "./input/state.ts";
import { topicPolicy } from "./topic/config.ts";
import { immediate, eligible, finalizeExecution, type LoopStatus } from "./loop.ts";
import { ROUTE_TYPE, type RouteStatus } from "./route/model.ts";
import { deliver, routed } from "./route/delivery.ts";
import { defaultDestination, routeByRules } from "./route/rules.ts";
import { z } from "zod";
import type { ExecutionScope } from "../../src/protocol/verbs.ts";
import type { TopicSpec, TopicStatus } from "./topic/model.ts";
import { inputPrinter } from "./input/printer.ts";
import type { Logger } from "pino";
import type { Resource, ResourceType } from "@compforge/aide-plugin";
import type { InputReceipt, InputSpec, InputStatus } from "./input/model.ts";
import type { Manager } from "../../src/host/plugin/manager.ts";
import { ApplicationRuntime } from "../../src/host/runtime/index.ts";
import { PluginResourceStore } from "../../src/host/plugin/resource/store.ts";
import { IncomingSchema, type Incoming, type OutputView } from "./model.ts";
import { WorkService } from "./work.ts";
import { output, Store } from "./store.ts";
import { workType, WORK_TYPES, type WorkSpec } from "./resources.ts";
import { TOPIC_TYPE, INPUT_TYPE, digest } from "./chief-model.ts";
import { TopicDeletionBlocked, type TopicDeletion } from "./topic/model.ts";
import { TopicStore, topicKey } from "./topic/store.ts";
import type { InputStore } from "./input/store.ts";
import { chiefTools } from "../../agents/chief/chief-tools.ts";
import { createChiefAgent, type ChiefAgentOptions } from "../../agents/chief/agent.ts";
import type { PiSessionFactory } from "../../src/host/harness/pi/adapter.ts";
import type { ConnectorClient } from "@compforge/aide-plugin";
import { channelRelation } from "./person/relation.ts";
import { LOCAL_ME, personRef, type Me } from "./person/model.ts";
import type { Persons } from "./person/service.ts";

/** Channels and Sources submit durable input; Chief decides whether Work is needed. */
export class Personal {
  readonly store: Store;
  readonly plugins: Manager;
  private readonly connectors: ConnectorClient;
  private intake: Promise<unknown> = Promise.resolve();
  private starting?: Promise<void>;
  private closed = false;

  readonly core: ApplicationRuntime;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(private readonly options: { timezone: string; persons: Persons; channelMe: Me; topic?: unknown; weave?: unknown }, private readonly log: Logger,
    runtime: { runtime: ApplicationRuntime; connectors: ConnectorClient; inputs: InputStore; outputs: OutputStore; contactMe?: ConstructorParameters<typeof TopicStore>[4] }) {
    this.core = runtime.runtime;
    this.connectors = runtime.connectors;
    this.plugins = this.core.plugins;
    const resources = new PluginResourceStore({ home: runtime.inputs.storage.home, pluginInstanceId: "personal" });
    const client = this.plugins.resourceClient("personal");
    this.store = new Store(resources, client, new TopicStore(resources, client, runtime.inputs, runtime.outputs, runtime.contactMe));
  }

  /** @spec Persistent native tools resolve the live execution on each call, never capture a completed invocation's verbs. */
  chiefSession(scope: ExecutionScope, config: ChiefAgentOptions["config"]): PiSessionFactory {
    const ref = scope.resourceRef;
    if (scope.pluginInstanceId !== "personal" || ref?.kind !== TOPIC_TYPE.kind || ref.apiVersion !== TOPIC_TYPE.apiVersion || !ref.uid) throw new Error("Chief requires a Topic resource scope");
    return async (options) => {
      const initial = this.store.resources.get<TopicSpec, TopicStatus>(TOPIC_TYPE, ref.name, ref.namespace);
      if (initial.metadata.uid !== ref.uid || initial.metadata.deletionTimestamp) throw new Error("Chief Topic is missing or replaced");
      const topicId = initial.spec.id;
      const active = () => {
        const c = this.topics.resource(topicId);
        if (!c || c.metadata.uid !== initial.metadata.uid || c.spec.parentRef || !c.status.execution) throw new Error("Chief execution is not active");
        this.plugins.executionVerbs(c.status.execution.id, { topicId });
        return c;
      };
      const assess = async (input: AssessInput) => {
        const c = active();
        const result = await assessInput(this.plugins.resourceClient("personal"), c, c.status.execution!.id, input);
        this.log.info({ topicId, inputId: input.inputId, workUids: input.workRequests?.map(r => r.workUid) ?? [] }, "Chief assessment completed");
        return result;
      };
      const tools = chiefTools(this.connectors, async (id, input) => {
        const c = active();
        return say(this.plugins.executionVerbs(c.status.execution!.id, { topicId }), { ...input, idempotencyKey: id });
      }, (id, offset) => {
        const c = active();
        return this.readLoopInput(resourceRef(c), id, offset, true);
      }, assess, async input => {
        const c = active();
        const result = await summarizeTopic(this.plugins.resourceClient("personal"), c, c.status.execution!.id, input,
          topicPolicy(this.options.topic).summaryChars);
        this.log.info({ topicId }, "Chief understanding updated");
        return result;
      });
      return createChiefAgent({ ...options, scope: `chief:${initial.metadata.uid}`, config, work: this.work(topicId), persons: this.options.persons, tools: [...tools, ...topicTools(this.store, active)], background: () => new TopicBackground(this.store, active(), topicId), beforeWorkMutation: () => { active(); } });
    };
  }

  weaveSession(scope: ExecutionScope, config: PiConfig): PiSessionFactory {
    return weaveSession(scope, config, this.store, this.plugins, topicPolicy(this.options.topic).summaryChars, weavePolicy(this.options.weave).batchSize, this.options.persons);
  }

  routineSession(scope: ExecutionScope, config: PiConfig): PiSessionFactory {
    return routineSession(scope, config, this.store, this.plugins, this.log, this.options.persons);
  }

  taskSession(scope: ExecutionScope, config: PiConfig): PiSessionFactory {
    return taskSession(scope, config, this.store, this.plugins, this.log, this.options.persons);
  }

  routeSession(scope: ExecutionScope, config: ChiefAgentOptions["config"]): PiSessionFactory {
    const ref = scope.resourceRef;
    if (scope.pluginInstanceId !== "personal" || ref?.kind !== ROUTE_TYPE.kind || ref.apiVersion !== ROUTE_TYPE.apiVersion || !ref.uid) throw new Error("Route requires a Route resource scope");
    return async options => {
      const initial = this.store.resources.get<Record<string, never>, RouteStatus>(ROUTE_TYPE, ref.name, ref.namespace);
      if (initial.metadata.uid !== ref.uid || initial.metadata.deletionTimestamp) throw new Error("Route resource is missing or replaced");
      const active = () => {
        const route = this.store.resources.get<Record<string, never>, RouteStatus>(ROUTE_TYPE, ref.name, ref.namespace);
        if (route.metadata.uid !== initial.metadata.uid || !route.status.execution) throw new Error("Route execution is not active");
        this.plugins.executionVerbs(route.status.execution.id, {});
        return route;
      };
      return createRouteAgent({ ...options, config, scope: `route:${initial.metadata.uid}`, background: identityBackground(this.options.persons, () => { active(); return new RouteBackground(this.store); }), port: {
        topics: (offset, query, parentUid) => {
          active();
          const page = contextPage(topicCandidates(this.store, query, parentUid), offset);
          return { topics: page.items, total: page.total, fingerprint: page.fingerprint, nextOffset: page.nextOffset };
        },
        input: (id, offset) => { const r = active(); return this.readLoopInput(resourceRef(r), id, offset); },
        route: async raw => {
          const args = z.object({ inputId: z.string(), topicUids: z.array(z.string()).max(1), reason: z.string().min(1).max(4000) }).strict().parse(raw);
          const r = active();
          const input = this.topics.inputStore.get(args.inputId);
          if (!input) throw new Error("Input is not owned by Route");
          if (routed(input)) return { routed: args.inputId };
          if (input.status.route?.executionId !== r.status.execution!.id) throw new Error("Input has not been admitted to Route");
          const resources = this.plugins.resourceClient("personal");
          const context = { resources, logger: { info: (message: string, detail?: unknown) => this.log.info({ detail }, message) } };
          const topics = await resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
          const destinations = [...new Set(args.topicUids)].map(uid => {
            const c = topics.find(c => c.metadata.uid === uid && !c.metadata.deletionTimestamp);
            if (!c) throw new Error(`Topic no longer exists: ${uid}`);
            return { name: c.metadata.name, uid };
          });
          if (!destinations.length) destinations.push(await defaultDestination(context));
          await deliver(context, input, destinations, args.reason);
          return { routed: args.inputId, topicUids: destinations.map(c => c.uid) };
        },
      } });
    };
  }

  private readLoopInput(owner: import("@compforge/aide-plugin").ResourceRef, id: string | undefined, offset: number, history = false) {
    const inputs = this.store.resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: owner.kind === "Route"
      ? { name: "routePending", value: "pending" } : { name: "assessPending", value: owner.uid! } });
    const c = owner.kind === "Topic" ? this.store.resources.get<TopicSpec, TopicStatus>(TOPIC_TYPE, owner.name) : undefined;
    if (!id) return { ...(c ? { context: { version: c.metadata.resourceVersion, summary: c.status.summary, recent: c.status.recent,
      summaryChars: topicPolicy(this.options.topic).summaryChars } } : {}), inputs: inputs.slice(offset, offset + 20).map(i => ({ inputId: i.metadata.name, status: attemptOf(i, owner) })),
      nextOffset: offset + 20 < inputs.length ? offset + 20 : null };
    const input = this.topics.inputStore.get(id);
    if (!input || (!inputs.some(i => i.metadata.name === id) && !(history && c && (input.status.assess?.[owner.uid!] || input.status.route?.result?.topics.some(ref => topicSubtree(this.store.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE), c).some(t => t.metadata.uid === ref.uid)))))) throw new Error("Input is not attached to this resource");
    const description = inputPrinter.describe(input);
    return { inputId: id, status: attemptOf(input, owner), text: description.slice(offset, offset + 8000), nextOffset: offset + 8000 < description.length ? offset + 8000 : null };
  }

  /** @spec Only the owning resource's intake controller may steer its live agent; admission is durable before dispatch. */
  async submitInput(scope: ExecutionScope, raw: unknown) {
    const { inputId } = z.object({ inputId: z.string().min(1) }).strict().parse(raw);
    const ref = scope.resourceRef;
    if (scope.pluginInstanceId !== "personal" || !ref?.uid || scope.controllerName || !["Route", "Topic", "Task", "Routine"].includes(ref.kind)) throw new Error("submit_input requires an owning intake controller");
    const resources = this.plugins.resourceClient("personal");
    let admitted: { input: Readonly<Resource<InputSpec, InputStatus>>;
      executionId: string; invocationId: string } | undefined;
    for (let attempt = 0; ; attempt++) {
      const resource = await resources.get<unknown, LoopStatus>(ref);
      const input = await resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: inputId });
      const id = resource?.status.execution?.id;
      if (!id || !input || !resource || !eligible(input, resource)) return { accepted: false };
      const invocation = this.plugins.listHarnessInvocations().find(i => i.executionId === id && i.phase === "running");
      if (!invocation) return { accepted: false, reason: "not_running" };
      try {
        await resources.commit([
          // This is an admission revision, including rejected dispatches, not a count of consumed Inputs.
          { operation: "patchStatus", resource: resource!, patch: { execution: { ...resource!.status.execution!, admissionRevision: (resource!.status.execution!.admissionRevision ?? 0) + 1 } } },
          { operation: "patchStatus", resource: input, patch: attemptPatch(input, ref, { executionId: id, startedAt: new Date().toISOString(), lastError: undefined, nextAttemptAt: undefined,
            ...(ref.kind === "Route" ? { attempts: (input.status.route?.attempts ?? 0) + 1 } : {}) }) },
        ]);
        admitted = { input, executionId: id, invocationId: invocation.invocationId };
        break;
      } catch (error) {
        if (!/version conflict/.test(String(error))) throw error;
        if (attempt >= 8) {
          this.log.warn({ inputId, consumerUid: ref.uid, executionId: id }, "Steer admission conflicts exhausted; queued for retry");
          return { accepted: false, reason: "admission_conflict" };
        }
      }
    }
    const { input, executionId: id, invocationId } = admitted;
    const operation = immediate(input.spec) ? "steer" : "followUp";
    const message = `New Input:\n${JSON.stringify({ inputId })}\n${inputPreview(input)}\nUse read_input for full facts. Submit the business receipt when handled.`;
    try {
      const result = await this.plugins.executionVerbs(scope.executionId, scope.attributes ?? {}).harness({
        operation, invocationId, messageId: `input:${input.metadata.uid}:${ref.uid}`, prompt: message, timeoutMs: 30_000,
      });
      if (result.state !== "success") throw new Error(`Harness ${operation} ${result.state}${result.state === "failure" ? `: ${result.error}` : ""}`);
      const outcome = { accepted: result.value.outcome === "accepted", reason: result.value.reason };
      if (!outcome.accepted) {
        await changeAttempt(resources, inputId, ref, p => p?.executionId === id && !p.completedAt ? { executionId: undefined, startedAt: undefined } : {});
        // An explicit rejection has no effects. Wake followup even if the invocation ended during admission.
        void this.plugins.enqueue({ pluginInstanceId: "personal", namespace: ref.namespace, resourceApiVersion: ref.apiVersion, resourceKind: ref.kind, resourceId: ref.name, controllerName: "agent" })
          .catch(error => this.log.error({ err: error, inputId }, "Could not schedule rejected steer for followup"));
      }
      this.log.info({ inputId, consumerUid: ref.uid, invocationId, operation, ...outcome }, "Agent Input admission");
      return outcome;
    } catch (error) {
      await changeAttempt(resources, inputId, ref, p => p?.executionId === id && !p.completedAt ? { lastError: String(error) } : {});
      throw error;
    }
  }

  get topics() { return this.store.topics; }
  invocations() { return this.plugins.listHarnessInvocations().map(invocation => ({ ...invocation, ...personalExecution(invocation) })); }
  topicIds() { return [...new Set([...this.store.topics.list().map((item) => item.id), ...this.works().map((item) => item.topicId)])]; }
  works() { return this.store.read().works; }

  start(): Promise<void> { return this.starting ??= this.startOnce(); }

  /** Bind agent tools to this host's Task/Routine persistence and reconcilers. */
  work(topicId: string): WorkService { return new WorkService(this.store, topicId, this.log); }

  /**
   * @spec Topic deletion is revision checked and requires no pending activity or associated Work.
   * @why Shared Input facts and Session execution records outlive a Topic; delete only its resource.
   * @link docs/channel/web.md
   */
  async deleteTopic(topicId: string, revision: number, uid: string): Promise<TopicDeletion> {
    const topic = this.topics.resource(topicId);
    if (!topic) return { deleted: false, reason: "missing" };
    if (topic.metadata.uid !== uid || Number(topic.metadata.resourceVersion) !== revision) return { deleted: false, reason: "changed" };
    const unfinished = this.topics.pending(topic.metadata.uid).length > 0 || !!topic.status.execution;
    const executing = this.invocations().some((invocation) => invocation.topicId === topicId && ["queued", "running", "uncertain"].includes(invocation.phase));
    if (unfinished || executing) return { deleted: false, reason: "busy" };
    const hasWork = WORK_TYPES.some((type) => this.store.resources.list<WorkSpec, unknown>(type)
      .some((work) => work.spec.topicId === topicId));
    if (hasWork) return { deleted: false, reason: "work" };
    try {
      await this.plugins.resourceClient("personal").delete(TOPIC_TYPE, topic.metadata.name, "v1", { uid: topic.metadata.uid, resourceVersion: topic.metadata.resourceVersion });
    } catch (error) {
      if (error instanceof TopicDeletionBlocked) return { deleted: false, reason: error.reason };
      if (error instanceof Error && error.message === "Resource version conflict before deletion; read it again") return { deleted: false, reason: "changed" };
      throw error;
    }
    this.log.info({ topicId, revision, resourceUid: topic.metadata.uid }, "Deleted topic");
    return { deleted: true };
  }

  private async startOnce(): Promise<void> {
    await this.recoverInterrupted();
    await this.core.start();
    if (!this.plugins.isInstanceActive("personal")) throw new Error("Personal Plugin failed to start");
    for (const work of this.store.read().works) this.wake(workType(work.kind), work.id);
    for (const topic of this.store.topics.list()) {
      this.wake(TOPIC_TYPE, topicKey(topic.id));
    }
  }

  /** @spec Recovery retains unacknowledged effects as failed evidence; it never silently resubmits Chief actions. */
  async recoverInterrupted(): Promise<void> {
    const resources = this.plugins.resourceClient("personal");
    for (const type of [TOPIC_TYPE, ROUTE_TYPE, WEAVE_TYPE]) for (const c of await resources.list<unknown, LoopStatus>(type)) {
      if (!c.status.execution) continue;
      const id = c.status.execution.id;
      await finalizeExecution({ resources, logger: { debug: () => {}, info: () => {}, warn: (message: string, detail?: unknown) => this.log.warn({ detail }, message), error: () => {} } }, c, id);
      this.log.warn({ resourceUid: c.metadata.uid, executionId: id }, "Recovered interrupted agent without replaying actions");
    }
    for (const work of this.store.read().works) {
      if (work.status !== "running") continue;
      work.status = "uncertain"; work.nextAt = null;
      const text = `「${work.title}」执行被中断，结果未知。请核对外部结果后告诉我是否继续。`;
      work.recent.push({ at: new Date().toISOString(), text });
      const target = this.topics.resource(work.topicId)?.spec.address;
      await this.store.save(work, target ? [output(work.topicId, text, work.id, target)] : []);
      this.log.warn({ workId: work.id }, "Recovered interrupted work as uncertain");
    }
  }

  private enqueue(type: ResourceType, id: string): Promise<void> {
    return this.core.enqueue("personal", type, id);
  }

  private wake(type: ResourceType, id: string): void {
    if (this.closed || !this.plugins.isInstanceActive("personal")) return;
    const pending = this.enqueue(type, id).catch((err: unknown) => {
      if (!this.closed) this.log.error({ err, resourceId: id }, "Personal reconcile failed");
    }).finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }

  receive(raw: Incoming): Promise<InputReceipt> {
    if (this.closed) return Promise.reject(new Error("Aide is shutting down"));
    const input = IncomingSchema.parse(raw);
    const result = this.intake.then(async () => { await this.start(); return this.submit(input); });
    this.intake = result.catch(() => {});
    return result;
  }

  outputs(): OutputView[] {
    return this.store.read().outputs;
  }

  private async submit(incoming: Incoming): Promise<InputReceipt> {
    const input = incoming;
    const id = digest([input.channelId, input.topicKey ?? input.topicId ?? "", input.id]);
    // @spec Deleting a Topic never turns redelivery of an accepted Input into a new command.
    const fact = this.topics.inputStore.get(id);
    if (fact && routed(fact)) return { inputId: fact.metadata.name, at: fact.metadata.creationTimestamp };
    const receipt = this.topics.inputStore.receipt(id);
    if (!fact && receipt) return { inputId: id, at: receipt.at };
    if (!this.plugins.isInstanceActive("personal")) throw new Error("Personal Plugin is unavailable");
    const accepted = await this.acceptChannel(id, input);
    // Resolve explicit admission before the next Channel Input; receipt dedup above precedes creation.
    if (input.topicKey || input.topicId) await routeByRules({ resources: this.plugins.resourceClient("personal"),
      logger: { info: (message, detail) => this.log.info({ detail }, message) } }, accepted);
    this.log.info({ topicId: input.topicId, inputId: id, channelId: input.channelId, relation: accepted.spec.relation ?? "unknown" }, "Accepted Chief input");
    return { inputId: accepted.metadata.name, at: accepted.metadata.creationTimestamp };
  }

  private async acceptChannel(id: string, input: Incoming) {
    const relation = channelRelation(this.options.channelMe, input);
    let sender;
    if (input.channelId === "web") { const me = await this.options.persons.findIdentity(LOCAL_ME); if (me) sender = personRef(me); }
    else if (input.channelId === "lark") {
      const observation = input.observation as { provider?: string; accountId?: string; sender?: { id?: string; type?: string; name?: string }; mentions?: string[] } | undefined;
      if (observation?.provider === "lark" && observation.accountId) {
        const identity = (id: string) => ({ provider: "lark", scope: observation.accountId!, id });
        if (observation.sender?.type === "user" && observation.sender.id) sender = personRef(await this.options.persons.observe(identity(observation.sender.id), observation.sender.name));
        // A mention has no subject type; it may identify the bot rather than a person.
      }
    }
    const fact = await this.topics.submit(id, { attention: "immediate", topicKey: input.topicKey, topicId: input.topicId, text: input.text, timezone: this.options.timezone,
      origin: "channel", originId: input.channelId, source: input.source, ...(sender ? { sender } : {}), ...(relation ? { relation } : {}),
      ...(input.observation ? { observation: input.observation } : {}) });
    return fact;
  }

  async event(input: { id: string; topicId: string; name: string; text: string }): Promise<number> {
    if (this.closed) throw new Error("Aide is shutting down");
    const name = digest(["routine-event", input.topicId, input.id]);
    const store = this.topics.inputStore;
    const spec: InputSpec = { origin: "source", originId: "personal.events", topicId: input.topicId,
      text: input.text, observation: { event: input.name } };
    if (store.get(name) || store.receipt(name)) { store.submit(input.topicId, name, spec); return 0; }
    const targets = this.store.read().works.filter(work => work.kind === "routine" && work.topicId === input.topicId
      && work.trigger?.event === input.name && ["scheduled", "ready", "running"].includes(work.status));
    await this.topics.ensure(input.topicId);
    const c = this.topics.resource(input.topicId)!;
    const at = new Date().toISOString();
    const resources = targets.map(work => this.store.resources.get(workType(work.kind), work.id));
    await this.store.client.commit([
      ...resources.map(resource => ({ operation: "patchStatus" as const, resource, patch: { idleSince: null, agentStoppedAt: null } })),
      { operation: "create", type: INPUT_TYPE, name, spec, status: {
        route: { completedAt: at, result: { topics: [resourceRef(c)], reason: "Routine event subscription" } },
        handle: Object.fromEntries(resources.map(resource => [resource.metadata.uid, { resource: resourceRef(resource), assignedAt: at, request: { action: "context" } }])),
      } },
    ]);
    this.log.info({ inputId: name, eventId: input.id, count: resources.length }, "Routine event assigned through Input");
    return resources.length;
  }

  async settled(): Promise<void> {
    await this.starting;
    await this.intake;
    do { await Promise.all([...this.pending]); await this.plugins.settled(); } while (this.pending.size);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.starting; await this.core.close(); await this.intake;
  }
}
