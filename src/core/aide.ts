import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { Manager } from "../plugin/manager.ts";
import { PluginInstanceStore } from "../plugin/instance.ts";
import { OutcomeSchema, RouteSchema, type Agent, type Route } from "./agent.ts";
import { IncomingSchema, nextOccurrence, validateTrigger, type Incoming, type Message, type Work } from "./model.ts";
import { message, Store, WORK_TYPE, type WorkResource } from "./store.ts";

/** Channel intake changes desired state; the personal Plugin alone reconciles Work. */
export class Aide {
  readonly store: Store;
  readonly plugins: Manager;
  private intake: Promise<unknown> = Promise.resolve();
  private starting?: Promise<void>;
  private closed = false;

  constructor(home: string, private readonly agent: Agent, private readonly log: Logger) {
    const instances = new PluginInstanceStore({ session: { id: "aide", dir: home } });
    if (!instances.list().some((instance) => instance.pluginInstanceId === "personal")) {
      instances.create({ pluginInstanceId: "personal", pluginId: "aide.personal", packageVersion: "0.1.0" });
    }
    this.plugins = new Manager(instances, log);
    this.store = new Store(this.plugins.resourceStore("personal"), (change) => this.plugins.changed(change));
  }

  start(): Promise<void> { return this.starting ??= this.startOnce(); }

  private async startOnce(): Promise<void> {
    // A crashed CLI might have already written externally. Reconcile must not replay it automatically.
    for (const work of this.store.read().works) {
      if (work.status !== "running") continue;
      work.status = "uncertain"; work.nextAt = null;
      this.store.save(work, [message(work.conversationId,
        `「${work.title}」执行被中断，结果未知。请核对外部结果后告诉我是否继续。`, work.id)]);
      this.log.warn({ workId: work.id }, "Recovered interrupted work as uncertain");
    }
    await this.plugins.activate("personal", {
      pluginId: "aide.personal", version: "0.1.0",
      activate: (context) => context.registerController<WorkResource["spec"], WorkResource["status"]>({
        resourceType: WORK_TYPE,
        reconcile: async (_context, resource) => {
          if (resource.metadata.deletionTimestamp) return;
          await this.reconcile(resource.metadata.name);
          const current = this.store.get(resource.metadata.name);
          if (current.status === "scheduled" && current.nextAt) {
            return { requeueAfterMs: Math.max(1, Date.parse(current.nextAt) - Date.now()) };
          }
        },
      }),
    });
    await this.plugins.start();
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
    const route = RouteSchema.parse(await this.agent.route(input,
      state.works.filter((work) => work.conversationId === input.conversationId),
      state.messages.filter((item) => item.conversationId === input.conversationId)));
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

  private async reconcile(id: string): Promise<void> {
    const work = this.store.get(id);
    if (work.status !== "ready" && !(work.status === "scheduled" && work.nextAt && Date.parse(work.nextAt) <= Date.now())) return;
    this.store.save({ ...work, status: "running" });
    this.log.info({ workId: id, kind: work.kind, revision: work.revision }, "Execution started");
    try {
      const result = OutcomeSchema.parse(await this.agent.execute(work));
      if (result.action === "ask" && !result.question?.trim()) throw new Error("ask requires a question");
      if (result.action === "wait" && (!result.nextAt || !Number.isFinite(Date.parse(result.nextAt))
        || Date.parse(result.nextAt) <= Date.now())) throw new Error("wait requires a future nextAt");
      const current = this.store.get(id);
      current.history.push({ at: new Date().toISOString(), role: "aide", text: result.summary });
      if (current.revision !== work.revision) {
        if (current.status !== "paused") current.status = "ready";
      } else if (result.action === "ask") {
        current.status = "waiting"; current.question = result.question; current.nextAt = null;
      } else if (result.action === "wait") {
        current.status = "scheduled"; current.nextAt = result.nextAt;
      } else {
        current.status = current.kind === "task" ? "done" : "scheduled";
        current.nextAt = nextOccurrence(current.trigger, new Date());
      }
      const text = current.revision === work.revision && result.action === "ask" ? result.question : result.notification;
      this.store.save(current, text ? [message(current.conversationId, text, id)] : []);
      this.log.info({ workId: id, status: current.status }, "Execution recorded");
    } catch (error) {
      const current = this.store.get(id);
      current.status = "uncertain"; current.nextAt = null;
      current.history.push({ at: new Date().toISOString(), role: "aide", text: "Execution failed; external effects are unknown. Verify before retrying." });
      this.store.save(current, [message(current.conversationId,
        `「${current.title}」执行失败，外部操作结果尚不确定。请核对后告诉我是否继续。`, id)]);
      this.log.error({ err: error, workId: id }, "Execution outcome uncertain");
    }
  }

  async settled(): Promise<void> { await this.starting; await this.intake; await this.plugins.settled(); }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.starting; await this.intake; await this.plugins.close();
  }
}
