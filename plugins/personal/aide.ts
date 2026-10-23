import { personalExecution } from "./execution-context.ts";
import { say } from "./output/action.ts";
import type { OutputStore } from "./output/store.ts";
import { createRouteAgent } from "../../agents/route/agent.ts";
import { completeInputs } from "./conversation/complete.ts";
import { conversationPolicy } from "./conversation/config.ts";
import { immediate, processing, type LoopStatus } from "./loop.ts";
import { ROUTE_TYPE, ROUTE_NAME, type RouteStatus } from "./route/model.ts";
import { deliver, routed } from "./route/delivery.ts";
import { defaultDestination } from "./route/rules.ts";
import { z } from "zod";
import type { ExecutionScope } from "../../src/protocol/verbs.ts";
import type { ConversationSpec, ConversationStatus } from "./conversation/model.ts";
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
import { CONVERSATION_TYPE, INPUT_TYPE, chiefTarget, digest } from "./chief-model.ts";
import { type ConversationDeletion } from "./conversation/model.ts";
import { ConversationStore, conversationKey } from "./conversation/store.ts";
import type { InputStore } from "./input/store.ts";
import { chiefTools } from "../../agents/chief/chief-tools.ts";
import { createChiefAgent, type ChiefAgentOptions } from "../../agents/chief/agent.ts";
import type { PiSessionFactory } from "../../src/host/harness/pi/adapter.ts";
import type { ConnectorClient } from "@compforge/aide-plugin";
import { channelRelation } from "./person/relation.ts";
import { personRef, type Me } from "./person/model.ts";
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
  private readonly chiefConversations = new Map<string, string>();

  constructor(private readonly options: { timezone: string; persons: Persons; me: Me; conversation?: unknown }, private readonly log: Logger,
    runtime: { runtime: ApplicationRuntime; connectors: ConnectorClient; inputs: InputStore; outputs: OutputStore }) {
    this.core = runtime.runtime;
    this.connectors = runtime.connectors;
    this.plugins = this.core.plugins;
    const resources = new PluginResourceStore({ home: runtime.inputs.storage.home, pluginInstanceId: "personal" });
    const client = this.plugins.resourceClient("personal");
    this.store = new Store(resources, client, new ConversationStore(resources, client, runtime.inputs, runtime.outputs));
    for (const conversation of this.store.conversations.list()) this.registerConversation(conversation.id);
    this.store.conversations.subscribe((conversation) => this.registerConversation(conversation.id));
  }

  private registerConversation(conversationId: string): void {
    const conversation = this.conversations.resource(conversationId);
    if (!conversation) return;
    const id = chiefTarget(conversationId);
    if (this.chiefConversations.has(id)) return;
    this.chiefConversations.set(id, conversationId);
    this.core.registerTarget({ id, harness: "chief" });
  }

  /** @spec Persistent native tools resolve the live execution on each call, never capture a completed invocation's verbs. */
  chiefSession(targetId: string, config: ChiefAgentOptions["config"]): PiSessionFactory {
    const conversationId = this.chiefConversations.get(targetId);
    if (!conversationId) throw new Error("Unknown Chief target");
    return async (options) => {
      const initial = this.conversations.resource(conversationId)!;
      const active = () => {
        const c = this.conversations.resource(conversationId);
        if (!c || c.metadata.uid !== initial.metadata.uid || !c.status.execution) throw new Error("Chief execution is not active");
        this.plugins.executionVerbs(c.status.execution.id, { conversationId });
        return c;
      };
      const complete = async (input: { inputIds: string[]; summary: string }) => {
        const c = active();
        const result = await completeInputs(this.plugins.resourceClient("personal"), c, c.status.execution!.id, input,
          conversationPolicy(this.options.conversation).summaryChars);
        this.log.info({ conversationId, inputIds: input.inputIds }, "Chief acknowledged inputs");
        return result;
      };
      const tools = chiefTools(this.connectors, async (id, input) => {
        const c = active();
        return say(this.plugins.executionVerbs(c.status.execution!.id, { conversationId }), { ...input, idempotencyKey: id });
      }, (id, offset) => {
        const c = active();
        return this.readLoopInput(c.metadata.uid, c.status.pendingInputIds, id, offset, true);
      }, complete);
      return createChiefAgent({ ...options, config, work: this.work(conversationId), persons: this.options.persons, tools, beforeWorkMutation: () => { active(); } });
    };
  }

  routeSession(config: ChiefAgentOptions["config"]): PiSessionFactory {
    return async options => {
      const initial = this.store.resources.get<Record<string, never>, RouteStatus>(ROUTE_TYPE, ROUTE_NAME);
      const active = () => {
        const route = this.store.resources.get<Record<string, never>, RouteStatus>(ROUTE_TYPE, ROUTE_NAME);
        if (route.metadata.uid !== initial.metadata.uid || !route.status.execution) throw new Error("Route execution is not active");
        this.plugins.executionVerbs(route.status.execution.id, {});
        return route;
      };
      return createRouteAgent({ ...options, config, scope: `route:${initial.metadata.uid}`, port: {
        conversations: offset => {
          active();
          const all = this.conversations.list().map(view => {
            const c = this.conversations.resource(view.id)!;
            return { uid: c.metadata.uid, name: c.spec.name, default: !!c.spec.default, summary: (c.status.summary ?? "").slice(0, 2000) };
          });
          return { conversations: all.slice(offset, offset + 20), nextOffset: offset + 20 < all.length ? offset + 20 : null };
        },
        input: (id, offset) => { const r = active(); return this.readLoopInput(r.metadata.uid, r.status.pendingInputIds, id, offset); },
        route: async raw => {
          const args = z.object({ inputId: z.string(), conversationUids: z.array(z.string()).max(100), reason: z.string().min(1).max(4000) }).strict().parse(raw);
          const r = active();
          const input = this.conversations.inputStore.get(args.inputId);
          if (!input || (!r.status.pendingInputIds.includes(args.inputId) && !routed(input))) throw new Error("Input is not owned by Route");
          if (routed(input)) return { routed: args.inputId };
          if (input.status.processing?.[r.metadata.uid]?.executionId !== r.status.execution!.id) throw new Error("Input has not been admitted to Route");
          const resources = this.plugins.resourceClient("personal");
          const context = { resources, logger: { info: (message: string, detail?: unknown) => this.log.info({ detail }, message) } };
          const conversations = await resources.list<ConversationSpec, ConversationStatus>(CONVERSATION_TYPE);
          const destinations = [...new Set(args.conversationUids)].map(uid => {
            const c = conversations.find(c => c.metadata.uid === uid && !c.metadata.deletionTimestamp);
            if (!c) throw new Error(`Conversation no longer exists: ${uid}`);
            return { name: c.metadata.name, uid };
          });
          if (!destinations.length) destinations.push(await defaultDestination(context));
          await deliver(context, input, destinations, args.reason);
          return { routed: args.inputId, conversationUids: destinations.map(c => c.uid) };
        },
      } });
    };
  }

  private readLoopInput(uid: string, pending: string[], id: string | undefined, offset: number, history = false) {
    if (!id) return { inputs: pending.slice(offset, offset + 20).map(id => ({ inputId: id, processing: this.conversations.inputStore.get(id)?.status.processing?.[uid] })),
      nextOffset: offset + 20 < pending.length ? offset + 20 : null };
    const input = this.conversations.inputStore.get(id);
    if (!input || (!pending.includes(id) && !(history && input.status.deliveries?.includes(uid)))) throw new Error("Input is not attached to this resource");
    const description = inputPrinter.describe(input);
    return { inputId: id, processing: input.status.processing?.[uid], text: description.slice(offset, offset + 8000), nextOffset: offset + 8000 < description.length ? offset + 8000 : null };
  }

  /** @spec Only the owning resource's intake controller may steer its live agent; admission is durable before dispatch. */
  async steerInput(scope: ExecutionScope, raw: unknown) {
    const { inputId } = z.object({ inputId: z.string().min(1) }).strict().parse(raw);
    const ref = scope.resourceRef;
    if (scope.pluginInstanceId !== "personal" || !ref?.uid || scope.controllerName || !["Route", "Conversation"].includes(ref.kind)) throw new Error("steer_input requires an owning intake controller");
    const resources = this.plugins.resourceClient("personal");
    let admitted: { input: Readonly<Resource<InputSpec, InputStatus>>;
      executionId: string; invocationId: string } | undefined;
    for (let attempt = 0; ; attempt++) {
      const resource = await resources.get<unknown, LoopStatus>(ref);
      const input = await resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: inputId });
      const id = resource?.status.execution?.id;
      if (!id || !input || !resource!.status.pendingInputIds.includes(inputId) || !immediate(input.spec) || input.status.processing?.[ref.uid]) return { accepted: false };
      const invocation = this.plugins.listHarnessInvocations().find(i => i.executionId === id && i.phase === "running");
      if (!invocation) return { accepted: false, reason: "not_running" };
      try {
        await resources.commit([
          // This is an admission revision, including rejected dispatches, not a count of consumed Inputs.
          { operation: "patchStatus", resource: resource!, patch: { execution: { ...resource!.status.execution!, admissionRevision: (resource!.status.execution!.admissionRevision ?? 0) + 1 } } },
          { operation: "patchStatus", resource: input, patch: { processing: { ...input.status.processing,
            [ref.uid]: { executionId: id, phase: "submitted", at: new Date().toISOString() } } } },
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
    const message = `Immediate Input: ${JSON.stringify({ inputId })}\n${inputPrinter.describe(input).slice(0, 12000)}\nUse read_input for full facts. Submit the business receipt when handled.`;
    try {
      const outcome = await this.core.executions.steer(invocationId, `input:${input.metadata.uid}:${ref.uid}`, message);
      if (!outcome.accepted) {
        await processing(resources, inputId, ref.uid, p => p?.executionId === id && p.phase !== "done" ? undefined : p);
        // An explicit rejection has no effects. Wake followup even if the invocation ended during admission.
        void this.plugins.enqueue({ pluginInstanceId: "personal", namespace: ref.namespace, resourceApiVersion: ref.apiVersion, resourceKind: ref.kind, resourceId: ref.name, controllerName: "agent" })
          .catch(error => this.log.error({ err: error, inputId }, "Could not schedule rejected steer for followup"));
      }
      this.log.info({ inputId, consumerUid: ref.uid, invocationId, ...outcome }, "Immediate Input steering admission");
      return outcome;
    } catch (error) {
      await processing(resources, inputId, ref.uid, p => p?.executionId === id && p.phase === "submitted" ? { ...p, phase: "failed", error: String(error) } : p);
      throw error;
    }
  }

  get me() { return this.options.persons.me(); }

  get conversations() { return this.store.conversations; }
  invocations() { return this.plugins.listHarnessInvocations().map(invocation => ({ ...invocation, ...personalExecution(invocation) })); }
  conversationIds() { return [...new Set([...this.store.conversations.list().map((item) => item.id), ...this.works().map((item) => item.conversationId)])]; }
  works() { return this.store.read().works; }

  start(): Promise<void> { return this.starting ??= this.startOnce(); }

  /** Bind agent tools to this host's Task/Routine persistence and reconcilers. */
  work(conversationId: string): WorkService { return new WorkService(this.store, conversationId, this.log); }

  /**
   * @spec Conversation deletion is revision checked and requires no pending activity or associated Work.
   * @why Shared Input facts and Session execution records outlive a Conversation; delete only its resource.
   * @link docs/channel/web.md
   */
  async deleteConversation(conversationId: string, revision: number, uid: string): Promise<ConversationDeletion> {
    const conversation = this.conversations.resource(conversationId);
    if (!conversation) return { deleted: false, reason: "missing" };
    if (conversation.metadata.uid !== uid || Number(conversation.metadata.resourceVersion) !== revision) return { deleted: false, reason: "changed" };
    const unfinished = conversation.status.pendingInputIds.length > 0 || !!conversation.status.execution;
    const executing = this.invocations().some((invocation) => invocation.conversationId === conversationId && ["queued", "running", "uncertain"].includes(invocation.phase));
    if (unfinished || executing) return { deleted: false, reason: "busy" };
    const hasWork = WORK_TYPES.some((type) => this.store.resources.list<WorkSpec, unknown>(type)
      .some((work) => work.spec.conversationId === conversationId));
    if (hasWork) return { deleted: false, reason: "work" };
    await this.plugins.resourceClient("personal").delete(CONVERSATION_TYPE, conversation.metadata.name);
    this.log.info({ conversationId, revision, resourceUid: conversation.metadata.uid }, "Deleted conversation");
    return { deleted: true };
  }

  private async startOnce(): Promise<void> {
    await this.recoverInterrupted();
    await this.core.start();
    if (!this.plugins.isInstanceActive("personal")) throw new Error("Personal Plugin failed to start");
    for (const work of this.store.read().works) this.wake(workType(work.kind), work.id);
    for (const conversation of this.store.conversations.list()) {
      this.wake(CONVERSATION_TYPE, conversationKey(conversation.id));
    }
  }

  /** @spec Recovery retains unacknowledged effects as failed evidence; it never silently resubmits Chief actions. */
  async recoverInterrupted(): Promise<void> {
    const resources = this.plugins.resourceClient("personal");
    for (const type of [CONVERSATION_TYPE, ROUTE_TYPE]) for (const c of await resources.list<unknown, LoopStatus>(type)) {
      if (!c.status.execution) continue;
      const id = c.status.execution.id;
      for (const inputId of c.status.pendingInputIds) await processing(resources, inputId, c.metadata.uid, p => {
        if (p?.executionId !== id || p.phase !== "submitted") return p;
        return type.kind === "Route" ? undefined : { ...p, phase: "failed", error: "Execution interrupted; inspect existing effects before continuing" };
      });
      const current = await resources.get<unknown, LoopStatus>({ ...c, ...c.metadata });
      if (current?.status.execution?.id === id) await resources.patchStatus(current, { execution: null });
      this.log.warn({ resourceUid: c.metadata.uid, executionId: id }, "Recovered interrupted agent without replaying actions");
    }
    for (const work of this.store.read().works) {
      if (work.status !== "running") continue;
      work.status = "uncertain"; work.nextAt = null;
      const text = `「${work.title}」执行被中断，结果未知。请核对外部结果后告诉我是否继续。`;
      work.history.push({ at: new Date().toISOString(), role: "aide", text });
      const target = this.conversations.resource(work.conversationId)?.spec.address;
      await this.store.save(work, target ? [output(work.conversationId, text, work.id, target)] : []);
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
    const input = { ...incoming, conversationId: incoming.sessionId };
    const id = digest([input.channelId, input.conversationId, input.id]);
    const previous = this.store.conversations.input(id, input.conversationId);
    if (previous) return { inputId: previous.metadata.name, at: previous.metadata.creationTimestamp };
    // @spec Deleting a Conversation never turns redelivery of an accepted Input into a new command.
    const fact = this.conversations.inputStore.get(id);
    if (fact?.status.deliveries?.includes(this.conversations.resource(input.conversationId)?.metadata.uid ?? "")) return { inputId: fact.metadata.name, at: fact.metadata.creationTimestamp };
    if (fact && ["done", "ignored"].includes(fact.status.routing?.phase ?? "")) return { inputId: fact.metadata.name, at: fact.metadata.creationTimestamp };
    const receipt = this.conversations.inputStore.receipt(id);
    if (!fact && receipt) return { inputId: id, at: receipt.at };
    await this.conversations.ensure(input.sessionId);
    if (!this.plugins.isInstanceActive("personal")) throw new Error("Personal Plugin is unavailable");
    this.registerConversation(input.conversationId);
    const accepted = await this.acceptChannel(id, input);
    this.log.info({ conversationId: input.conversationId, inputId: id, channelId: input.channelId, relation: accepted.spec.relation ?? "unknown" }, "Accepted Chief input");
    return { inputId: accepted.metadata.name, at: accepted.metadata.creationTimestamp };
  }

  private async acceptChannel(id: string, input: Incoming) {
    const me = await this.me;
    const relation = channelRelation(me?.spec ?? this.options.me, input);
    let sender;
    if (input.channelId === "web") { const me = await this.me; if (me) sender = personRef(me); }
    else if (input.channelId === "lark") {
      const observation = input.observation as { provider?: string; accountId?: string; sender?: { id?: string; type?: string; name?: string }; mentions?: string[] } | undefined;
      if (observation?.provider === "lark" && observation.accountId) {
        const identity = (id: string) => ({ provider: "lark", scope: observation.accountId!, id });
        if (observation.sender?.type === "user" && observation.sender.id) sender = personRef(await this.options.persons.observe(identity(observation.sender.id), observation.sender.name));
        // A mention has no subject type; it may identify the bot rather than a person.
      }
    }
    const fact = await this.conversations.submit(id, { attention: "immediate", sessionId: input.sessionId, text: input.text, timezone: this.options.timezone,
      origin: "channel", originId: input.channelId, source: input.source, ...(sender ? { sender } : {}), ...(relation ? { relation } : {}),
      ...(input.observation ? { observation: input.observation } : {}) });
    return fact;
  }

  async event(input: { id: string; conversationId: string; name: string; text: string }): Promise<number> {
    if (this.closed) throw new Error("Aide is shutting down");
    const key = JSON.stringify([input.conversationId, input.id]);
    let count = 0;
    for (const work of this.store.read().works) {
      if (work.kind !== "routine" || work.conversationId !== input.conversationId || work.trigger?.event !== input.name
        || !["scheduled", "ready", "running"].includes(work.status) || this.store.hasEvent(work.id, key)) continue;
      work.history.push({ at: new Date().toISOString(), role: "event", text: `${input.name}: ${input.text}` });
      if (work.status !== "running") work.status = "ready";
      work.revision++;
      await this.store.save(work, [], undefined, key); count++;
    }
    this.log.info({ eventId: input.id, name: input.name, count }, "Accepted event");
    return count;
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
