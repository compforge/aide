import type { Logger } from "pino";
import { SessionHeartbeat } from "../../src/host/heartbeat.ts";
import type { ResourceType } from "@compforge/aide-plugin";
import type { Manager } from "../../src/host/plugin/manager.ts";
import { CoreSession } from "../../src/host/core/index.ts";
import { type SessionHandle } from "../../src/host/store/store.ts";
import { PluginResourceStore } from "../../src/host/plugin/resource.ts";
import { IncomingSchema, type Incoming, type Message } from "./model.ts";
import { WorkService } from "./work.ts";
import { message, Store } from "./store.ts";
import { workType } from "./resources.ts";
import { CONVERSATION_TYPE, INPUT_TYPE, chiefTarget, chiefRouterTarget, digest } from "./chief-model.ts";
import { inboundMessage } from "./conversation-model.ts";
import { ConversationStore, conversationKey } from "./conversation-store.ts";
import { createPiAgent } from "../../agents/pi/agent.ts";
import type { InputStore } from "../../src/host/input/store.ts";
import { chiefTools } from "../../agents/chief/chief-tools.ts";
import { createChiefAgent, type ChiefAgentOptions } from "../../agents/chief/agent.ts";
import type { PiSessionFactory } from "../../src/host/harness/pi/adapter.ts";
import type { ConnectorClient } from "@compforge/aide-plugin";

/** Channels and Sources submit durable input; Chief decides whether Work is needed. */
export class Personal {
  readonly store: Store;
  readonly plugins: Manager;
  private readonly connectors: ConnectorClient;
  private intake: Promise<unknown> = Promise.resolve();
  private starting?: Promise<void>;
  private closed = false;

  readonly core: CoreSession;
  readonly heartbeat: SessionHeartbeat;
  private readonly session: SessionHandle;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly chiefConversations = new Map<string, string>();
  private readonly hasSources: boolean;
  private readonly targets: { id: string; harness: string }[];

  constructor(private readonly options: { timezone: string }, private readonly log: Logger,
    runtime: { core: CoreSession; session: SessionHandle; connectors: ConnectorClient; targets: { id: string; harness: string }[]; inputs: InputStore; watches: readonly { sessionId: string }[] }) {
    this.core = runtime.core;
    this.session = runtime.session;
    this.connectors = runtime.connectors;
    this.targets = runtime.targets;
    this.plugins = this.core.pluginManager!;
    const resources = new PluginResourceStore({ session: this.session, pluginInstanceId: "personal" });
    const client = this.plugins.resourceClient("personal");
    this.store = new Store(resources, client, new ConversationStore(this.id, resources, client, runtime.inputs));
    const router = chiefRouterTarget(this.id);
    this.targets.push({ id: router, harness: "chief" });
    if (!this.session.meta.lanes[router]) this.session.setLane(router, { laneId: router, createdFor: { type: "session" }, harnessSessions: {} });
    this.session.setHarnessTarget(router, { harnessTargetId: router, harness: "chief" });
    this.heartbeat = new SessionHeartbeat(this.session, this.conversations, async (id, _conversationId) => {
      if (this.closed || !this.plugins.isInstanceActive("personal")) throw new Error("Personal Plugin is unavailable for heartbeat input");
      await this.conversations.submit(id, { sessionId: this.id, origin: "heartbeat", timezone: this.options.timezone,
        text: "例行回顾：检查已有关注范围和相关工作，按需核实最新事实，判断有没有值得推进的下一步。没有值得处理的事情就保持安静。" });
      this.wake(INPUT_TYPE, id);
      this.log.info({ inputId: id, sessionId: this.id }, "Accepted heartbeat input");
    });
    const watches = runtime.watches;
    for (const conversation of this.store.conversations.list()) this.registerConversation(conversation.id);
    this.store.conversations.subscribe((conversation) => this.registerConversation(conversation.id));
    this.hasSources = watches.length > 0;
  }

  private registerConversation(conversationId: string): void {
    const id = chiefTarget(conversationId);
    if (this.chiefConversations.has(id)) return;
    this.chiefConversations.set(id, conversationId);
    if (!this.session.meta.lanes[id]) this.session.setLane(id, { laneId: id, createdFor: { type: "session" }, harnessSessions: {} });
    this.targets.push({ id, harness: "chief" });
    this.session.setHarnessTarget(id, { harnessTargetId: id, harness: "chief" });
  }

  /** Personal binds a Chief session and its tools to one conversation; the adapter remains business-agnostic. */
  chiefSession(targetId: string, config: ChiefAgentOptions["config"]): PiSessionFactory {
    if (targetId === chiefRouterTarget(this.id)) return (options) => createPiAgent({ ...options, config, scope: targetId,
      nativeTools: [], systemPrompt: "You are Chief routing. Select relevant conversations from the supplied summaries. Return the requested JSON only. Do not execute actions." });
    const conversationId = this.chiefConversations.get(targetId);
    if (!conversationId) throw new Error("Unknown Chief target");
    const active = () => {
      const inputs = this.store.conversations.inputs().filter((item) =>
        item.conversationId === conversationId && item.status.phase === "running");
      if (inputs.length !== 1 || inputs[0]!.status.question || inputs[0]!.status.quietReason) throw new Error("Chief is not accepting further mutations in this turn");
      return inputs[0]!;
    };
    const tools = chiefTools(this.connectors, async (question) => {
      const input = active();
      await this.store.conversations.update(input, { question });
    }, async (quietReason) => {
      const input = active();
      if (input.spec.origin === "channel") throw new Error("Channel input cannot be dismissed silently");
      await this.store.conversations.update(input, { quietReason });
    });
    return (options) => createChiefAgent({ ...options, config, work: this.work(conversationId),
      tools, beforeWorkMutation: () => { active(); } });
  }

  get id() { return this.session.id; }
  get conversations() { return this.store.conversations; }
  invocations() { return this.plugins.listHarnessInvocations(); }
  conversationIds() { return [...new Set([...this.store.conversations.list().map((item) => item.id), ...this.works().map((item) => item.conversationId)])]; }
  works() { return this.store.read().works; }

  start(): Promise<void> { return this.starting ??= this.startOnce(); }

  /** Bind agent tools to this host's Task/Routine persistence and reconcilers. */
  work(conversationId: string): WorkService { return new WorkService(this.store, conversationId, this.log); }

  private async startOnce(): Promise<void> {
    if (this.hasSources) await this.conversations.ensure();
    await this.recoverInterrupted();
    await this.core.start();
    if (!this.plugins.isInstanceActive("personal")) throw new Error("Personal Plugin failed to start");
    for (const work of this.store.read().works) this.wake(workType(work.kind), work.id);
    for (const conversation of this.store.conversations.list()) {
      if (conversation.pendingInputIds.length) this.wake(CONVERSATION_TYPE, conversationKey(conversation.id));
    }
  }

  async recoverInterrupted(): Promise<void> {
    for (const input of this.store.conversations.inputs()) {
      if (input.status.phase !== "running" && input.status.phase !== "waiting") continue;
      await this.store.conversations.update(input, {
        phase: "failed", question: null, messages: [...input.status.messages ?? [],
          message(input.conversationId, "上次处理已中断，可能已有部分操作生效。请核对后重新交办。")],
      });
      this.log.warn({ inputId: input.metadata.name }, "Recovered interrupted Chief input without replay");
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

  receive(raw: Incoming): Promise<Message> {
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
      return conversationId ? [{ conversationId, request: item.request }] : [];
    });
  }

  messages(): Message[] {
    return [...this.store.read().messages, ...this.questions().map(({ conversationId, request }) => ({
      id: request.messageId, conversationId, role: "aide" as const, at: request.createdAt, workId: null,
      text: request.request.kind === "question" ? request.request.questions.map((question) =>
        [question.question, ...(question.choices ?? []).map((choice) => `${choice.label} (${choice.value})`)].join("\n")).join("\n") : "",
    }))].sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  }

  private async submit(incoming: Incoming): Promise<Message> {
    const input = { ...incoming, conversationId: this.id };
    await this.conversations.ensure();
    const id = digest([input.conversationId, input.id]);
    const previous = this.store.conversations.input(id);
    if (previous) return previous.status.messages?.[0] ?? message(input.conversationId, "已接收该消息");
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
        const inbound = resource.status.messages![0]!;
        const receipt = await this.core.resolveInteraction({ kind: "interaction_response", messageId: request.messageId },
          async () => ({ kind: "question", outcome: "answered", answers: { [question.questionId]: [value!] } }));
        if (!receipt.result) {
          await this.store.conversations.update(this.conversations.input(id, this.id)!, { phase: "failed",
            messages: [inbound, message(input.conversationId, "这个问题已失效，答复没有继续执行。请重新交办。")] });
        }
        return inbound;
      }
      const notice = message(input.conversationId, "请先明确回复当前问题的选项（确认 / 拒绝），也可以从网页取消这次等待。");
      const accepted = await this.acceptChannel(id, input, [notice], "done", request.messageId);
      return accepted.status.messages![0]!;
    }
    const accepted = await this.acceptChannel(id, input, []);
    this.wake(CONVERSATION_TYPE, conversationKey(input.conversationId));
    this.log.info({ conversationId: input.conversationId, inputId: id }, "Accepted Chief input");
    return accepted.status.messages![0]!;
  }

  private async acceptChannel(id: string, input: Incoming, messages: Message[], phase?: "done", replyTo?: string) {
    const fact = await this.conversations.submit(id, { sessionId: this.id, text: input.text, timezone: this.options.timezone, origin: "channel", ...(replyTo ? { replyTo } : {}) });
    const delivered = [inboundMessage(fact, this.id), ...messages.filter((message) => message.role !== "user")];
    for (let attempt = 0; ; attempt++) {
      const c = await this.conversations.ensure();
      const ids = new Set(c.status.messages.map((m) => m.id));
      const extra = delivered.filter((m) => !ids.has(m.id));
      const attached = c.spec.inputIds.includes(id);
      if (attached && !extra.length) break;
      try {
        await this.plugins.resourceClient("personal").replace(c, { ...c.spec, inputIds: [...new Set([...c.spec.inputIds, id])] }, {
          ...c.status, processing: { ...c.status.processing, [id]: { ...c.status.processing[id], ...(phase ? { phase } : {}), messages: delivered } },
          messages: [...c.status.messages, ...extra],
        });
        break;
      } catch (error) {
        if (attempt >= 4 || !/version|conflict/i.test(String(error))) throw error;
      }
    }
    const latest = this.conversations.inputStore.get(id)!;
    const c = this.conversations.resource(this.id)!;
    if (!latest.status.routing) this.conversations.inputStore.update(latest, { routing: { phase: "done", reason: "Channel Session", targets: [{ sessionId: this.id, name: c.metadata.name, uid: c.metadata.uid }] } });
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
