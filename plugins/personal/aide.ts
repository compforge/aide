import { say } from "./output/action.ts";
import { sameAddress } from "../../src/address.ts";
import { outputWrite } from "./output.ts";
import type { OutputStore } from "./output/store.ts";
import { updateBatch } from "./conversation/state.ts";
import { activeBatch } from "./conversation/batch.ts";
import { appendConversationInput } from "./conversation/input.ts";
import { createPiAgent } from "../../agents/pi/agent.ts";
import { inputPrinter } from "./input/printer.ts";
import type { Logger } from "pino";
import type { ResourceType } from "@compforge/aide-plugin";
import type { InputReceipt } from "./input/model.ts";
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
  private readonly interruptedExecutions = new Set<string>();
  private readonly chiefConversations = new Map<string, string>();

  constructor(private readonly options: { timezone: string; persons: Persons; me: Me; conversation?: unknown }, private readonly log: Logger,
    runtime: { runtime: ApplicationRuntime; connectors: ConnectorClient; inputs: InputStore; outputs: OutputStore }) {
    this.core = runtime.runtime;
    this.connectors = runtime.connectors;
    this.plugins = this.core.plugins;
    const resources = new PluginResourceStore({ home: runtime.inputs.storage.home, pluginInstanceId: "personal" });
    const client = this.plugins.resourceClient("personal");
    this.store = new Store(resources, client, new ConversationStore(this.id, resources, client, runtime.inputs, runtime.outputs));
    for (const conversation of this.store.conversations.list()) this.registerConversation(conversation.id);
    this.store.conversations.subscribe((conversation) => {
      this.registerConversation(conversation.id);
      const batch = this.conversations.resource(conversation.id)?.status.batch;
      if (batch?.cancelRequested && batch.executionId && batch.phase === "running" && !this.interruptedExecutions.has(batch.executionId)) {
        this.interruptedExecutions.add(batch.executionId);
        this.plugins.interruptExecution(batch.executionId);
      }
      if (batch?.executionId && !activeBatch(batch)) this.interruptedExecutions.delete(batch.executionId);
    });
  }

  private registerConversation(conversationId: string): void {
    const conversation = this.conversations.resource(conversationId);
    if (!conversation) return;
    const id = chiefTarget(conversationId);
    if (this.chiefConversations.has(id)) return;
    this.chiefConversations.set(id, conversationId);
    this.core.registerTarget({ id, harness: "chief" });
  }

  /** Personal binds a Chief session and its tools to one conversation; the adapter remains business-agnostic. */
  chiefSession(targetId: string, config: ChiefAgentOptions["config"]): PiSessionFactory {
    const conversationId = this.chiefConversations.get(targetId);
    if (!conversationId) throw new Error("Unknown Chief target");
    return async (options) => {
      const initial = this.conversations.resource(conversationId)!;
      const bound = initial.status.batch;
      if (!bound?.executionId) throw new Error("Chief requires an executing Batch");
      if (bound.phase === "compacting") return createPiAgent({ ...options, config, scope: `chief:${conversationId}`, nativeTools: [], tools: [],
        systemPrompt: "Summarize supplied conversation facts. Return only the requested summary; do not perform actions.", extensionPaths: [] });
      const executionId = bound.executionId;
      const active = () => {
        const c = this.conversations.resource(conversationId);
        const b = c?.status.batch;
        if (!c || c.metadata.uid !== initial.metadata.uid || !b || b.id !== bound.id || b.executionId !== executionId
          || b.phase !== "running" || b.cancelRequested || b.quietReason) throw new Error("Chief Batch is not accepting further mutations");
        return b;
      };
      const verbs = this.plugins.executionVerbs(executionId, conversationId);
      const tools = chiefTools(this.connectors, async (quietReason) => {
        const b = active();
        if (b.context.responseRequired) throw new Error("Channel input cannot be dismissed silently");
        await updateBatch(this.plugins.resourceClient("personal"), initial, bound.id, () => ({ quietReason }), executionId);
      }, async (id, input) => { active(); return say(verbs, { ...input, idempotencyKey: id }); }, (id, offset) => {
        active();
        if (!id) return { inputIds: bound.inputIds.slice(offset, offset + 20), nextOffset: offset + 20 < bound.inputIds.length ? offset + 20 : null };
        const input = this.conversations.inputStore.get(id);
        if (!input || (!bound.inputIds.includes(id) && !input.status.deliveries?.includes(initial.metadata.uid))) throw new Error("Input is not attached to this Conversation");
        const description = inputPrinter.describe(input);
        return { inputId: id, text: description.slice(offset, offset + 8000), nextOffset: offset + 8000 < description.length ? offset + 8000 : null };
      });
      return createChiefAgent({ ...options, config, work: this.work(conversationId), persons: this.options.persons, tools, beforeWorkMutation: () => { active(); } });
    };
  }

  get me() { return this.options.persons.me(); }

  get id() { return this.core.id; }
  get conversations() { return this.store.conversations; }
  invocations() { return this.plugins.listHarnessInvocations(); }
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
    const unfinished = conversation.status.pendingInputIds.length > 0 || activeBatch(conversation.status.batch);
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

  /** @spec Interruption never replays actions; direct requests receive one notice committed with their interrupted Batch. */
  async recoverInterrupted(): Promise<void> {
    for (const view of this.conversations.list()) {
      const c = this.conversations.resource(view.id)!;
      const batch = c.status.batch;
      if (!batch || !["running", "compacting"].includes(batch.phase)) continue;
      if (batch.phase === "compacting") {
        await updateBatch(this.plugins.resourceClient("personal"), c, batch.id, () => ({ executionId: undefined }));
        continue;
      }
      const immediate = batch.inputIds.map((id) => this.conversations.inputStore.get(id)?.spec)
        .filter((input) => input && (input.attention ?? (input.origin === "channel" ? "immediate" : "deferred")) === "immediate");
      const first = immediate[0]?.source;
      const target = immediate.length ? (first && immediate.every((input) => input?.source && sameAddress(first, input.source)) ? first : undefined) : c.spec.address;
      if (batch.context.responseRequired && !target) this.log.warn({ conversationId: c.spec.id, batchId: batch.id, inputCount: immediate.length }, "Interrupted Batch has no unambiguous communication address; retained interruption without sending notice");
      const notices = batch.context.responseRequired && target ? [output(view.id,
        "上次处理已中断，可能已有部分操作生效。已暂停自动执行，请核对后重新交办。", null, target)] : [];
      await this.plugins.resourceClient("personal").commit([
        { operation: "patchStatus", resource: c, patch: {
          batch: { ...batch, phase: "interrupted", result: { summary: batch.result?.summary ?? "", error: "Execution interrupted; verify existing actions before resuming" }, outputIds: [...batch.outputIds, ...notices.map((o) => o.id)] },
        } },
        ...notices.map((o) => outputWrite(c, o, batch.executionId ? { executionId: batch.executionId } : {})),
      ]);
      this.log.warn({ batchId: batch.id, conversationId: view.id }, "Recovered interrupted Batch without replay");
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
    const current = await this.conversations.ensure(input.sessionId);
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
    await appendConversationInput(this.plugins.resourceClient("personal"), { name: current.metadata.name, uid: current.metadata.uid }, fact);

    return this.conversations.input(fact.metadata.name, input.sessionId)!;
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
