import { join } from "node:path";
import type { Logger } from "pino";
import type { ResourceType } from "@compforge/aide-plugin";
import type { Manager } from "../../src/host/plugin/manager.ts";
import { Channel, type ChannelControllerOptions } from "../../src/host/channel/index.ts";
import { SessionStore, type SessionHandle } from "../../src/host/store/store.ts";
import { PluginResourceStore } from "../../src/host/plugin/resource.ts";
import { PluginSupervisor } from "../../src/host/plugin/runner/index.ts";
import { PluginInstanceStore } from "../../src/host/plugin/instance.ts";
import { IncomingSchema, type Incoming, type Message } from "./model.ts";
import { WorkService } from "./work.ts";
import { message, Store } from "./store.ts";
import { workType } from "./resources.ts";
import { CONVERSATION_TYPE, chiefTarget, digest } from "./chief-model.ts";
import { conversationKey } from "../../src/host/conversation/store.ts";
import { chiefTools } from "../../agent/pi/chief-tools.ts";
import { createPiAgent, type PiAgentOptions } from "../../agent/pi/agent.ts";
import type { PiSessionFactory } from "../../src/host/harness/pi/adapter.ts";
import { Connectors } from "../../connectors/index.ts";
import { loadWatches } from "./source-config.ts";

/** Channels and Sources submit durable input; Chief decides whether Work is needed. */
export class Aide {
  readonly store: Store;
  readonly plugins: Manager;
  private intake: Promise<unknown> = Promise.resolve();
  private starting?: Promise<void>;
  private closed = false;

  readonly channel: Channel;
  private readonly session: SessionHandle;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly conversations = new Map<string, string>();
  private readonly targets = [{ id: "default", harness: "codex" }];

  constructor(private readonly home: string, private readonly options: {
    cwd: string; timezone: string; model?: string;
    createAdapter: ChannelControllerOptions["createAdapter"];
  }, private readonly log: Logger) {
    const sessions = new SessionStore(home);
    const previous = sessions.listSessions({ cwd: options.cwd })[0];
    this.session = previous ? sessions.openSession(previous.aideSessionId)
      : sessions.createSession({ cwd: options.cwd, title: "Aide" });
    const target = this.targets[0]!;
    this.session.setHarnessTarget(target.id, { harnessTargetId: target.id, harness: target.harness,
      ...(options.model ? { model: options.model } : {}) });
    const instances = new PluginInstanceStore({ session: this.session });
    if (!instances.list().some((instance) => instance.pluginInstanceId === "personal")) {
      instances.create({ pluginInstanceId: "personal", pluginId: "aide.personal", packageVersion: "0.1.0", marketplace: "builtin" });
    }
    this.channel = new Channel({ session: this.session,
      controller: { mentionBudgetChars: 0, createAdapter: options.createAdapter,
        resolveTarget: (id) => this.targets.find((item) => item.id === id) },
      plugins: { instances, harnessTargets: this.targets, selectedHarnessTargetId: () => target.id,
        harnessInvocationGate: () => "auto_approve", pluginSupervisor: new PluginSupervisor(),
        loadPackageEntry: async (pluginId, version) => ({ pluginId, version,
          entryUrl: new URL("./plugin.ts", import.meta.url).href }),
        onRunnerFailure: ({ error }) => { this.log.error({ err: error }, "Personal Plugin worker stopped"); this.recoverInterrupted(); },
      },
    });
    this.plugins = this.channel.pluginManager!;
    this.store = new Store(new PluginResourceStore({ session: this.session, pluginInstanceId: "personal" }),
      ({ resource }) => this.wake(resource, resource.metadata.name), this.plugins.conversations!);
    for (const conversation of this.store.conversations.list()) this.registerConversation(conversation.id);
    this.store.conversations.subscribe((conversation) => this.registerConversation(conversation.id));
    for (const watch of loadWatches()) this.registerConversation(watch.conversationId);
  }

  private registerConversation(conversationId: string): void {
    const id = chiefTarget(conversationId);
    if (this.conversations.has(id)) return;
    this.conversations.set(id, conversationId);
    this.targets.push({ id, harness: "pi" });
    this.session.setHarnessTarget(id, { harnessTargetId: id, harness: "pi" });
  }

  /** Composition binds a Pi session to one conversation; the adapter remains business-agnostic. */
  chiefSession(targetId: string, settings: Pick<PiAgentOptions, "agentDir" | "model"> = {}): PiSessionFactory {
    const conversationId = this.conversations.get(targetId);
    if (!conversationId) throw new Error("Unknown Chief target");
    const active = () => {
      const inputs = this.store.conversations.inputs().filter((item) =>
        item.spec.conversationId === conversationId && item.status.phase === "running");
      if (inputs.length !== 1 || inputs[0]!.status.question || inputs[0]!.status.quietReason) throw new Error("Chief is not accepting further mutations in this turn");
      return inputs[0]!;
    };
    const tools = chiefTools(Connectors.load(), (question) => {
      const input = active();
      this.store.conversations.update(input, { question });
    }, (quietReason) => {
      const input = active();
      if (input.spec.origin !== "source") throw new Error("Only Source observations can be dismissed silently");
      this.store.conversations.update(input, { quietReason });
    });
    return (options) => createPiAgent({ ...options, ...settings, work: this.work(conversationId),
      sessionDir: join(this.home, "pi-sessions"), tools, beforeWorkMutation: () => { active(); } });
  }

  start(): Promise<void> { return this.starting ??= this.startOnce(); }

  /** Bind agent tools to this host's Task/Routine persistence and reconcilers. */
  work(conversationId: string): WorkService { return new WorkService(this.store, conversationId, this.log); }

  private async startOnce(): Promise<void> {
    this.recoverInterrupted();
    await this.channel.start();
    if (!this.plugins.isInstanceActive("personal")) throw new Error("Personal Plugin failed to start");
    for (const work of this.store.read().works) this.wake(workType(work.kind), work.id);
    for (const conversation of this.store.conversations.list()) {
      if (conversation.pendingInputIds.length) this.wake(CONVERSATION_TYPE, conversationKey(conversation.id));
    }
  }

  private recoverInterrupted(): void {
    for (const input of this.store.conversations.inputs()) {
      if (input.status.phase !== "running" && input.status.phase !== "waiting") continue;
      this.store.conversations.update(input, {
        phase: "failed", question: null, messages: [...input.status.messages ?? [],
          message(input.spec.conversationId, "上次处理已中断，可能已有部分操作生效。请核对后重新交办。")],
      });
      this.log.warn({ inputId: input.metadata.name }, "Recovered interrupted Chief input without replay");
    }
    for (const work of this.store.read().works) {
      if (work.status !== "running") continue;
      work.status = "uncertain"; work.nextAt = null;
      this.store.save(work, [message(work.conversationId,
        `「${work.title}」执行被中断，结果未知。请核对外部结果后告诉我是否继续。`, work.id)]);
      this.log.warn({ workId: work.id }, "Recovered interrupted work as uncertain");
    }
  }

  private enqueue(type: ResourceType, id: string): Promise<void> {
    return this.plugins.enqueue({ aideSessionId: this.session.id, pluginInstanceId: "personal", namespace: "v1",
      resourceApiVersion: type.apiVersion, resourceKind: type.kind, resourceId: id,
      ...(type.kind === CONVERSATION_TYPE.kind ? { resourceOwner: "aide" as const } : {}) });
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
    const invocations = this.plugins.listHarnessInvocations();
    return [...this.channel.projection.interactions.values()].flatMap((item) => {
      if (item.request.request.kind !== "question" || !item.pluginContext) return [];
      const invocation = invocations.find((entry) => entry.executionId === item.pluginContext!.executionId);
      const conversationId = invocation?.harnessTargetId ? this.conversations.get(invocation.harnessTargetId) : undefined;
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

  private async submit(input: Incoming): Promise<Message> {
    const id = digest([input.conversationId, input.id]);
    const previous = this.store.conversations.input(id);
    if (previous) return previous.status.messages?.[0] ?? message(input.conversationId, "已接收该消息");
    if (!this.plugins.isInstanceActive("personal")) throw new Error("Personal Plugin is unavailable");
    this.registerConversation(input.conversationId);
    const inbound: Message = { ...message(input.conversationId, input.text), role: "user" };
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
        const resource = this.store.conversations.submit(id, { conversationId: input.conversationId, text: input.text, timezone: this.options.timezone, origin: "channel", replyTo: request.messageId }, { phase: "done", messages: [inbound] });
        const receipt = await this.channel.resolveInteraction({ kind: "interaction_response", messageId: request.messageId },
          async () => ({ kind: "question", outcome: "answered", answers: { [question.questionId]: [value!] } }));
        if (!receipt.result) {
          this.store.conversations.update(resource, { phase: "failed",
            messages: [inbound, message(input.conversationId, "这个问题已失效，答复没有继续执行。请重新交办。")] });
        }
        return inbound;
      }
      const notice = message(input.conversationId, "请先明确回复当前问题的选项（确认 / 拒绝），也可以从网页取消这次等待。");
      this.store.conversations.submit(id, { conversationId: input.conversationId, text: input.text, timezone: this.options.timezone, origin: "channel" }, { phase: "done", messages: [inbound, notice] });
      return inbound;
    }
    this.store.conversations.submit(id, { conversationId: input.conversationId, text: input.text, timezone: this.options.timezone, origin: "channel" }, { messages: [inbound] });
    this.wake(CONVERSATION_TYPE, conversationKey(input.conversationId));
    this.log.info({ conversationId: input.conversationId, inputId: id }, "Accepted Chief input");
    return inbound;
  }

  event(input: { id: string; conversationId: string; name: string; text: string }): number {
    if (this.closed) throw new Error("Aide is shutting down");
    const key = JSON.stringify([input.conversationId, input.id]);
    let count = 0;
    for (const work of this.store.read().works) {
      if (work.kind !== "routine" || work.conversationId !== input.conversationId || work.trigger?.event !== input.name
        || !["scheduled", "ready", "running"].includes(work.status) || this.store.hasEvent(work.id, key)) continue;
      work.history.push({ at: new Date().toISOString(), role: "event", text: `${input.name}: ${input.text}` });
      if (work.status !== "running") work.status = "ready";
      work.revision++;
      this.store.save(work, [], undefined, key); count++;
    }
    this.log.info({ eventId: input.id, name: input.name, count }, "Accepted event");
    return count;
  }

  async settled(): Promise<void> {
    await this.starting;
    await this.intake;
    do { await Promise.all([...this.pending]); } while (this.pending.size);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.starting; await this.channel.close(); await this.intake;
  }
}
