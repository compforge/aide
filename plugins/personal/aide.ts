import { createHash, randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { ResourceType } from "@compforge/aide-plugin";
import type { Manager } from "../../src/runtime/plugin/manager.ts";
import { Channel, type ChannelControllerOptions } from "../../src/runtime/channel/index.ts";
import { SessionStore, type SessionHandle } from "../../src/runtime/store/store.ts";
import { PluginResourceStore } from "../../src/runtime/plugin/resource.ts";
import { PluginSupervisor } from "../../src/runtime/plugin/runner/index.ts";
import { INTAKE_TYPE } from "./resources.ts";
import type { IntakeSpec, IntakeStatus } from "./plugin.ts";
import { PluginInstanceStore } from "../../src/runtime/plugin/instance.ts";
import { RouteSchema, type Route } from "./prompts.ts";
import { IncomingSchema, nextOccurrence, validateTrigger, type Incoming, type Message, type Work } from "./model.ts";
import { message, Store, WORK_TYPE } from "./store.ts";

/** Channel intake changes desired state; the personal Plugin alone reconciles Work. */
export class Aide {
  readonly store: Store;
  readonly plugins: Manager;
  private intake: Promise<unknown> = Promise.resolve();
  private starting?: Promise<void>;
  private closed = false;

  readonly channel: Channel;
  private readonly session: SessionHandle;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(home: string, private readonly options: {
    cwd: string; timezone: string; model?: string;
    createAdapter: ChannelControllerOptions["createAdapter"];
  }, private readonly log: Logger) {
    const sessions = new SessionStore(home);
    const previous = sessions.listSessions({ cwd: options.cwd })[0];
    this.session = previous ? sessions.openSession(previous.aideSessionId)
      : sessions.createSession({ cwd: options.cwd, title: "Aide" });
    const target = { id: "default", harness: "codex" };
    this.session.setHarnessTarget(target.id, { harnessTargetId: target.id, harness: target.harness,
      ...(options.model ? { model: options.model } : {}) });
    const instances = new PluginInstanceStore({ session: this.session });
    if (!instances.list().some((instance) => instance.pluginInstanceId === "personal")) {
      instances.create({ pluginInstanceId: "personal", pluginId: "aide.personal", packageVersion: "0.1.0", marketplace: "builtin" });
    }
    this.channel = new Channel({ session: this.session,
      controller: { mentionBudgetChars: 0, createAdapter: options.createAdapter,
        resolveTarget: (id) => id === target.id ? target : undefined },
      plugins: { instances, harnessTargets: [target], selectedHarnessTargetId: () => target.id,
        harnessInvocationGate: () => "auto_approve", pluginSupervisor: new PluginSupervisor(),
        loadPackageEntry: async (pluginId, version) => ({ pluginId, version,
          entryUrl: new URL("./plugin.ts", import.meta.url).href }),
        onRunnerFailure: ({ error }) => { this.log.error({ err: error }, "Personal Plugin worker stopped"); this.recoverInterrupted(); },
      },
    });
    this.plugins = this.channel.pluginManager!;
    this.store = new Store(new PluginResourceStore({ session: this.session, pluginInstanceId: "personal" }),
      ({ resource }) => this.wake(resource, resource.metadata.name));
  }

  start(): Promise<void> { return this.starting ??= this.startOnce(); }

  private async startOnce(): Promise<void> {
    this.recoverInterrupted();
    await this.channel.start();
    if (!this.plugins.isInstanceActive("personal")) throw new Error("Personal Plugin failed to start");
    for (const work of this.store.read().works) this.wake(WORK_TYPE, work.id);
  }

  private recoverInterrupted(): void {
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
      resourceApiVersion: type.apiVersion, resourceKind: type.kind, resourceId: id });
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
    const result = this.intake.then(async () => { await this.start(); return this.route(input); });
    this.intake = result.catch(() => {});
    return result;
  }

  private async route(input: Incoming): Promise<Message> {
    const key = JSON.stringify([input.conversationId, input.id]);
    const existing = this.store.response(key);
    if (existing) return existing;
    const state = this.store.read();
    if (!this.plugins.isInstanceActive("personal")) throw new Error("Personal Plugin is unavailable; restart Aide to recover");
    const id = createHash("sha256").update(key).digest("hex");
    if (!this.store.resources.find(INTAKE_TYPE, id)) this.store.resources.create<IntakeSpec, IntakeStatus>({
      type: INTAKE_TYPE, name: id, spec: { input, timezone: this.options.timezone,
        works: state.works.filter((work) => work.conversationId === input.conversationId),
        history: state.messages.filter((item) => item.conversationId === input.conversationId) }, status: {},
    });
    await this.enqueue(INTAKE_TYPE, id);
    const status = this.store.resources.get<IntakeSpec, IntakeStatus>(INTAKE_TYPE, id).status;
    if (status.error) throw new Error(`Intake failed: ${status.error}`);
    const route = RouteSchema.parse(status.route);
    const response = this.apply(input, route, key);
    this.log.info({ conversationId: input.conversationId, workId: response.workId, action: route.action }, "Routed input");
    return response;
  }

  private apply(input: Incoming, route: Route, key: string): Message {
    let work: Work | undefined;
    const now = new Date();
    if (route.action === "create" || route.action === "update") {
      if (!route.kind || !route.title?.trim() || !route.instruction?.trim()) throw new Error("Work needs a kind, title and instruction");
      validateTrigger(route.kind, route.trigger, now);
    }
    if (route.action === "create") {
      work = { id: randomUUID(), conversationId: input.conversationId, kind: route.kind!, title: route.title!,
        instruction: route.instruction!, trigger: route.trigger, status: route.kind === "routine" ? "scheduled" : "ready",
        revision: 1, nextAt: nextOccurrence(route.trigger, now), question: null, history: [],
      };
    } else if (route.action !== "reply") {
      work = this.store.read().works.find((item) => item.id === route.workId && item.conversationId === input.conversationId);
      if (!work) throw new Error(`Unknown work in this conversation: ${route.workId}`);
      if (route.action === "update") {
        Object.assign(work, { kind: route.kind, title: route.title, instruction: route.instruction, trigger: route.trigger });
        if (work.status !== "running") {
          work.status = work.kind === "routine" ? "scheduled" : "ready";
          work.nextAt = nextOccurrence(work.trigger, now);
        }
      } else if (route.action === "pause") {
        work.status = "paused"; work.nextAt = null;
      } else {
        if (route.action === "answer" && work.status !== "waiting") throw new Error(`Work ${work.id} is not waiting for an answer`);
        if (work.status !== "running") work.status = "ready";
        work.nextAt = null;
      }
      work.question = null; work.revision++;
    }
    work?.history.push({ at: now.toISOString(), role: "user", text: input.text });
    const inbound = { ...message(input.conversationId, input.text, work?.id ?? null), role: "user" as const };
    const response = message(input.conversationId, route.response, work?.id ?? null);
    const messages: Message[] = [inbound, response];
    if (work) this.store.save(work, messages, key);
    else this.store.reply(input.conversationId, messages, key);
    return response;
  }

  event(input: { id: string; conversationId: string; name: string; text: string }): number {
    if (this.closed) throw new Error("Aide is shutting down");
    const key = JSON.stringify([input.conversationId, input.id]);
    let count = 0;
    for (const work of this.store.read().works) {
      if (work.conversationId !== input.conversationId || work.trigger?.event !== input.name
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
