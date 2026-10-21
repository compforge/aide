import { assertInputCapacity } from "./conversation/input.ts";
import { environmentLifecycle } from "./source/environment/observe.ts";
import { messageLifecycle } from "./source/message/observe.ts";
import { requirementLifecycle } from "./source/requirement/observe.ts";
import { createPiAgent } from "../../agents/pi/agent.ts";
import { inputPrinter } from "../../src/host/input/printer.ts";
import { conversationPolicy } from "./conversation/config.ts";
import type { Logger } from "pino";
import type { ResourceType, InputReceipt } from "@compforge/aide-plugin";
import type { Manager } from "../../src/host/plugin/manager.ts";
import { CoreSession } from "../../src/host/core/index.ts";
import { type SessionHandle } from "../../src/host/store/store.ts";
import { PluginResourceStore } from "../../src/host/plugin/resource/store.ts";
import { IncomingSchema, type Incoming, type Message } from "./model.ts";
import { WorkService } from "./work.ts";
import { message, Store } from "./store.ts";
import { workType, WORK_TYPES, type WorkSpec } from "./resources.ts";
import { CONVERSATION_TYPE, INPUT_TYPE, chiefTarget, digest } from "./chief-model.ts";
import { initialConversationName, conversationLane, type ConversationDeletion } from "./conversation/model.ts";
import { ConversationStore, conversationKey } from "./conversation/store.ts";
import type { InputStore } from "../../src/host/input/store.ts";
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

  readonly core: CoreSession;
  private readonly session: SessionHandle;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly chiefConversations = new Map<string, string>();
  private readonly targets: { id: string; harness: string }[];

  constructor(private readonly options: { timezone: string; persons: Persons; me: Me; conversation?: unknown }, private readonly log: Logger,
    runtime: { core: CoreSession; session: SessionHandle; connectors: ConnectorClient; targets: { id: string; harness: string }[]; inputs: InputStore }) {
    this.core = runtime.core;
    this.session = runtime.session;
    this.connectors = runtime.connectors;
    this.targets = runtime.targets;
    this.plugins = this.core.pluginManager!;
    const resources = new PluginResourceStore({ session: this.session, pluginInstanceId: "personal" });
    for (const policy of [environmentLifecycle, messageLifecycle, requirementLifecycle]) resources.storage.register(resources.scope, policy);
    const client = this.plugins.resourceClient("personal");
    this.store = new Store(resources, client, new ConversationStore(this.id, resources, client, runtime.inputs));
    for (const conversation of this.store.conversations.list()) this.registerConversation(conversation.id);
    this.store.conversations.subscribe((conversation) => this.registerConversation(conversation.id));
  }

  private registerConversation(conversationId: string): void {
    const conversation = this.conversations.resource(conversationId);
    if (!conversation) return;
    const laneId = conversationLane(conversation);
    const id = chiefTarget(conversationId);
    if (!this.session.meta.lanes[laneId]) {
      // @why Reusing a deleted Conversation ID must not auto-restore its old Session history.
      this.session.setLane(laneId, { laneId, createdFor: { type: "session" }, harnessSessions: {},
        ...(this.session.meta.harnessTargets[id] ? { historyAfterSeq: this.core.projection.lastSeq } : {}) });
    }
    if (this.chiefConversations.has(id)) return;
    this.chiefConversations.set(id, conversationId);
    this.targets.push({ id, harness: "chief" });
    this.session.setHarnessTarget(id, { harnessTargetId: id, harness: "chief" });
  }

  /** Personal binds a Chief session and its tools to one conversation; the adapter remains business-agnostic. */
  chiefSession(targetId: string, config: ChiefAgentOptions["config"]): PiSessionFactory {
    const conversationId = this.chiefConversations.get(targetId);
    if (!conversationId) throw new Error("Unknown Chief target");
    const active = () => {
      const inputs = this.store.conversations.runs().filter((item) =>
        item.conversationId === conversationId && item.status.phase === "running" && !item.status.roundId);
      if (inputs.length !== 1 || inputs[0]!.status.question || inputs[0]!.status.quietReason || inputs[0]!.status.compacting) throw new Error("Chief is not accepting further mutations in this turn");
      return inputs[0]!;
    };
    const tools = chiefTools(this.connectors, async (question) => {
      const input = active();
      await this.store.conversations.updateRun(input, { question });
    }, async (quietReason) => {
      const input = active();
      if (input.input?.spec.origin === "channel" || input.status.batchInputIds?.some((id) => this.conversations.inputStore.get(id)?.spec.origin === "channel")) throw new Error("Channel input cannot be dismissed silently");
      await this.store.conversations.updateRun(input, { quietReason });
    }, async (id, text) => {
      const run = active();
      if ((run.status.notifications ?? []).some((n) => n.id === id)) return;
      await this.store.conversations.updateRun(run, { notifications: [...run.status.notifications ?? [], { id, text }] });
    }, (id, offset) => {
      const conversation = this.conversations.resource(conversationId);
      const input = this.conversations.inputStore.get(id);
      if (!conversation || !input || (!conversation.spec.inputIds.includes(id) && !input.status.deliveries?.includes(conversation.metadata.uid))) {
        throw new Error("Input is not attached to this Conversation");
      }
      const description = inputPrinter.describe(input);
      return { inputId: id, text: description.slice(offset, offset + 8000),
        nextOffset: offset + 8000 < description.length ? offset + 8000 : null };
    });
    return (options) => {
      const summary = this.conversations.runs(conversationId).some((r) => r.status.phase === "running" && r.status.compacting);
      if (summary) return createPiAgent({ ...options, config, scope: `chief:${conversationId}`, nativeTools: [], tools: [],
        systemPrompt: "Summarize supplied conversation facts. Return only the requested summary; do not perform actions.", extensionPaths: [] });
      return createChiefAgent({ ...options, config, work: this.work(conversationId), persons: this.options.persons, tools, beforeWorkMutation: () => { active(); } });
    };
  }

  get me() { return this.options.persons.me(); }

  get id() { return this.session.id; }
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
    const unfinished = this.conversations.runs(conversationId).some((run) => !["done", "failed"].includes(run.status.phase ?? ""));
    const executing = this.invocations().some((invocation) => invocation.conversationId === conversationId && ["queued", "running", "uncertain"].includes(invocation.phase));
    const pendingQuestion = this.questions().some((item) => item.conversationId === conversationId && item.request.status === "pending");
    if (unfinished || executing || pendingQuestion) return { deleted: false, reason: "busy" };
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

  /** @spec Interruption never replays actions; direct requests receive one notice committed with their failed round. */
  async recoverInterrupted(): Promise<void> {
    for (const input of this.store.conversations.runs()) {
      if (input.status.roundId || (input.status.phase !== "running" && input.status.phase !== "waiting")) continue;
      const c = this.conversations.resource(input.conversationId)!;
      const processing = { ...c.status.processing, [input.id]: { ...input.status,
        phase: "failed" as const, question: null, error: "Execution interrupted; verify existing actions before resuming" } };
      for (const id of input.status.batchInputIds ?? []) processing[id] = { ...processing[id], phase: "failed" };
      const direct = !input.status.compacting && (input.input?.spec.origin === "channel" ||
        input.status.batchInputIds?.some((id) => this.conversations.inputStore.get(id)?.spec.origin === "channel"));
      const notices = direct ? [message(input.conversationId,
        "上次处理已中断，可能已有部分操作生效。已暂停自动执行，请核对后重新交办。", null)] : [];
      processing[input.id] = { ...processing[input.id]!, messages: [...processing[input.id]!.messages ?? [], ...notices] };
      // Recovery disposition and its notice commit together: another restart cannot repeat the notification.
      await this.plugins.resourceClient("personal").patchStatus(c, { processing, messages: [...c.status.messages, ...notices], contextReady: false,
        blocked: { at: new Date().toISOString(), reason: "Execution interrupted; no automatic replay" } });
      this.log.warn({ runId: input.id, conversationId: input.conversationId }, "Recovered interrupted Chief activation without replay");
    }
    for (const work of this.store.read().works) {
      if (work.status !== "running") continue;
      work.status = "uncertain"; work.nextAt = null;
      await this.store.save(work, [message(work.conversationId,
        `「${work.title}」执行被中断，结果未知。请核对外部结果后告诉我是否继续。`, work.id)]);
      this.log.warn({ workId: work.id }, "Recovered interrupted work as uncertain");
    }
  }

  private enqueue(type: ResourceType, id: string): Promise<void> {
    return this.plugins.enqueue({ aideSessionId: this.session.id, pluginInstanceId: "personal", namespace: "v1",
      resourceApiVersion: type.apiVersion, resourceKind: type.kind, resourceId: id,
      ...(type.kind === INPUT_TYPE.kind ? { resourceOwner: "aide" as const } : {}) });
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

  /** Project original Core questions into the same channel outbox; delivery has its own dedup receipts. */
  questions() {
    return [...this.core.projection.interactions.values()].flatMap((item) => {
      if (item.request.request.kind !== "question" || !item.pluginContext) return [];
      const conversationId = item.pluginContext.conversationId;
      const conversation = conversationId && this.conversations.resource(conversationId);
      if (!conversation || item.request.createdAt < conversation.metadata.creationTimestamp || (item.pluginContext.resourceRef?.kind === CONVERSATION_TYPE.kind &&
        item.pluginContext.resourceRef.uid !== conversation.metadata.uid)) return [];
      return [{ conversationId: conversation.spec.id, request: item.request }];
    });
  }

  messages(): Message[] {
    return [...this.store.read().messages, ...this.questions().map(({ conversationId, request }) => ({
      id: request.messageId, conversationId, role: "aide" as const, at: request.createdAt, workId: null,
      text: request.request.kind === "question" ? request.request.questions.map((question) =>
        [question.question, ...(question.choices ?? []).map((choice) => `${choice.label} (${choice.value})`)].join("\n")).join("\n") : "",
    }))].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  private async submit(incoming: Incoming): Promise<InputReceipt> {
    const input = { ...incoming, conversationId: this.id };
    const id = digest([input.channelId, input.conversationId, input.id]);
    const previous = this.store.conversations.input(id, input.conversationId);
    if (previous) return { inputId: previous.metadata.name, at: previous.metadata.creationTimestamp };
    // @spec Deleting a Conversation never turns redelivery of an accepted Input into a new command.
    const fact = this.conversations.inputStore.get(id);
    if (fact?.status.deliveries?.includes(this.conversations.resource(input.conversationId)?.metadata.uid ?? "")) return { inputId: fact.metadata.name, at: fact.metadata.creationTimestamp };
    if (fact && ["done", "ignored"].includes(fact.status.routing?.phase ?? "")) return { inputId: fact.metadata.name, at: fact.metadata.creationTimestamp };
    const receipt = this.conversations.inputStore.receipt(id);
    if (!fact && receipt) return { inputId: id, at: receipt.at };
    await this.conversations.ensure();
    if (!this.plugins.isInstanceActive("personal")) throw new Error("Personal Plugin is unavailable");
    this.registerConversation(input.conversationId);
    const pending = this.questions().filter((item) => item.conversationId === input.conversationId && item.request.status === "pending");
    const request = pending.length === 1 ? pending[0]!.request : undefined;
    if (request?.request.kind === "question" && request.request.questions.length === 1) {
      const question = request.request.questions[0]!;
      const raw = input.text.trim();
      let value = question.choices?.find((choice) => choice.value === raw || choice.label === raw)?.value;
      if (!value && question.choices?.some((choice) => choice.value === "accept")) {
        if (/^(同意|确认|可以|好的|是|yes|y)$/i.test(raw)) value = "accept";
        if (/^(拒绝|不同意|不|否|不要|no|n)$/i.test(raw)) value = "decline";
      }
      if (!value && (!question.choices?.length || question.allowOther)) value = raw;
      if (value) {
        // Persist the reply identity before settling the Core Interaction. A redelivery cannot become a new command.
        const resource = await this.acceptChannel(id, input, [], "done", request.messageId);
        const receipt = await this.core.resolveInteraction({ kind: "interaction_response", messageId: request.messageId },
          async () => ({ kind: "question", outcome: "answered", answers: { [question.questionId]: [value!] } }));
        if (!receipt.result) {
          await this.store.conversations.update(this.conversations.input(id, this.id)!, { phase: "failed",
            messages: [message(input.conversationId, "这个问题已失效，答复没有继续执行。请重新交办。")] });
        }
        return { inputId: resource.metadata.name, at: resource.metadata.creationTimestamp };
      }
      const notice = message(input.conversationId, "请先明确回复当前问题的选项（确认 / 拒绝），也可以从网页取消这次等待。");
      const accepted = await this.acceptChannel(id, input, [notice], "done", request.messageId);
      return { inputId: accepted.metadata.name, at: accepted.metadata.creationTimestamp };
    }
    const accepted = await this.acceptChannel(id, input, []);
    this.wake(CONVERSATION_TYPE, conversationKey(input.conversationId));
    this.log.info({ conversationId: input.conversationId, inputId: id, channelId: input.channelId, relation: accepted.spec.relation ?? "unknown" }, "Accepted Chief input");
    return { inputId: accepted.metadata.name, at: accepted.metadata.creationTimestamp };
  }

  private async acceptChannel(id: string, input: Incoming, messages: Message[], phase?: "done", replyTo?: string) {
    const current = await this.conversations.ensure();
    if (!current.spec.inputIds.includes(id)) assertInputCapacity(current, { origin: "channel", originId: input.channelId, text: input.text, replyTo }, conversationPolicy(this.options.conversation).maxPending);
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
    const fact = await this.conversations.submit(id, { attention: "immediate", sessionId: this.id, text: input.text, timezone: this.options.timezone,
      origin: "channel", originId: input.channelId, ...(sender ? { sender } : {}), ...(relation ? { relation } : {}),
      ...(input.observation ? { observation: input.observation } : {}), ...(replyTo ? { replyTo } : {}) });
    for (let attempt = 0; ; attempt++) {
      const c = await this.conversations.ensure();
      const ids = new Set(c.status.messages.map((m) => m.id));
      const extra = messages.filter((m) => !ids.has(m.id));
      const attached = c.spec.inputIds.includes(id);
      if (!attached) assertInputCapacity(c, fact.spec, conversationPolicy(this.options.conversation).maxPending);
      if (attached && !extra.length) break;
      try {
        await this.plugins.resourceClient("personal").replace(c, { ...c.spec, name: c.spec.name || initialConversationName(this.conversations.inputStore.get(c.spec.inputIds[0] ?? id)?.spec.text ?? input.text), inputIds: [...new Set([...c.spec.inputIds, id])] }, {
          ...c.status, processing: { ...c.status.processing, [id]: { ...c.status.processing[id], ...(phase ? { phase } : {}), messages } },
          messages: [...c.status.messages, ...extra],
        });
        break;
      } catch (error) {
        if (attempt >= 4 || !/version|conflict/i.test(String(error))) throw error;
      }
    }
    return this.conversations.input(fact.metadata.name, this.id)!;
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
