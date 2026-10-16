import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { ReconcileDueQueue, ReconcileQueue } from "../runtime/queue.ts";
import { OutcomeSchema, RouteSchema, type Agent, type Route } from "./agent.ts";
import { IncomingSchema, nextOccurrence, validateTrigger, type Incoming, type Message, type Work } from "./model.ts";
import { findWork, message, Store } from "./store.ts";

/** @spec Intake and triggers update persisted work; reconcile alone dispatches execution. */
export class Aide {
  private readonly queue: ReconcileQueue;
  private readonly due: ReconcileDueQueue;
  private readonly pending = new Set<Promise<void>>();
  private intake: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(readonly store: Store, private readonly agent: Agent, private readonly log: Logger) {
    this.queue = new ReconcileQueue({ execute: (id) => this.reconcile(id) });
    this.due = new ReconcileDueQueue({ onDue: (id) => this.enqueue(id) });
  }

  /**
   * @spec Interrupted execution becomes uncertain, requiring an explicit user retry.
   * @why A crashed CLI might already have performed an external write; blindly retrying can duplicate it.
   */
  start(): void {
    this.store.update((state) => {
      for (const work of state.works) {
        if (work.status !== "running") continue;
        work.status = "uncertain";
        work.nextAt = null;
        state.messages.push(message(work.conversationId,
          `「${work.title}」执行被中断，结果未知。请核对外部结果后告诉我是否继续。`, work.id));
        this.log.warn({ workId: work.id }, "Recovered interrupted work as uncertain");
      }
    });
    for (const work of this.store.read().works) this.schedule(work);
  }

  receive(raw: Incoming): Promise<Message> {
    if (this.closed) return Promise.reject(new Error("Aide is shutting down"));
    const input = IncomingSchema.parse(raw);
    const result = this.intake.then(() => this.route(input));
    this.intake = result.catch(() => {});
    return result;
  }

  private async route(input: Incoming): Promise<Message> {
    const key = JSON.stringify([input.conversationId, input.id]);
    const state = this.store.read();
    const existing = state.inputs.find((item) => item.key === key);
    if (existing) return state.messages.find((item) => item.id === existing.responseId)!;
    const route = RouteSchema.parse(await this.agent.route(input,
      state.works.filter((work) => work.conversationId === input.conversationId),
      state.messages.filter((item) => item.conversationId === input.conversationId)));
    const response = this.apply(input, route, key);
    this.log.info({ conversationId: input.conversationId, workId: response.workId, action: route.action }, "Routed input");
    if (response.workId) this.schedule(findWork(this.store.read(), response.workId));
    return response;
  }

  private apply(input: Incoming, route: Route, key: string): Message {
    return this.store.update((state) => {
      let work: Work | undefined;
      const now = new Date();
      if (route.action === "create" || route.action === "update") {
        if (!route.kind || !route.title?.trim() || !route.instruction?.trim()) {
          throw new Error("Work needs a kind, title and instruction");
        }
        validateTrigger(route.kind, route.trigger, now);
      }
      if (route.action === "create") {
        work = {
          id: randomUUID(), conversationId: input.conversationId, kind: route.kind!,
          title: route.title!, instruction: route.instruction!, trigger: route.trigger,
          status: route.kind === "routine" ? "scheduled" : "ready", revision: 1,
          nextAt: nextOccurrence(route.trigger, now), question: null, history: [],
        };
        state.works.push(work);
      } else if (route.action !== "reply") {
        work = state.works.find((item) => item.id === route.workId && item.conversationId === input.conversationId);
        if (!work) throw new Error(`Unknown work in this conversation: ${route.workId}`);
        if (route.action === "update") {
          Object.assign(work, {
            kind: route.kind, title: route.title, instruction: route.instruction, trigger: route.trigger,
          });
          if (work.status !== "running") {
            work.status = work.kind === "routine" ? "scheduled" : "ready";
            work.nextAt = nextOccurrence(work.trigger, now);
          }
        } else if (route.action === "pause") {
          work.status = "paused";
          work.nextAt = null;
        } else {
          if (route.action === "answer" && work.status !== "waiting") {
            throw new Error(`Work ${work.id} is not waiting for an answer; use update or resume`);
          }
          if (work.status !== "running") work.status = "ready";
          work.nextAt = null;
        }
        work.question = null;
        work.revision++;
      }
      work?.history.push({ at: now.toISOString(), role: "user", text: input.text });
      const response = message(input.conversationId, route.response, work?.id ?? null);
      state.messages.push({ ...message(input.conversationId, input.text, work?.id ?? null), role: "user" }, response);
      state.inputs.push({ key, responseId: response.id });
      return response;
    });
  }

  event(input: { id: string; conversationId: string; name: string; text: string }): number {
    if (this.closed) throw new Error("Aide is shutting down");
    const key = JSON.stringify([input.conversationId, input.id]);
    const ids = this.store.update((state) => {
      if (state.events.includes(key)) return [];
      const matches = state.works.filter((work) => work.conversationId === input.conversationId
        && work.trigger?.event === input.name && ["scheduled", "ready", "running"].includes(work.status));
      for (const work of matches) {
        work.history.push({ at: new Date().toISOString(), role: "event", text: `${input.name}: ${input.text}` });
        if (work.status !== "running") work.status = "ready";
        work.revision++;
      }
      state.events.push(key);
      return matches.map((work) => work.id);
    });
    for (const id of ids) this.enqueue(id);
    this.log.info({ eventId: input.id, name: input.name, count: ids.length }, "Accepted event");
    return ids.length;
  }

  private schedule(work: Work): void {
    if (this.closed) return;
    this.due.schedule(work.id, work.status === "scheduled" && work.nextAt ? new Date(work.nextAt) : null);
    if (work.status === "ready") this.enqueue(work.id);
  }

  private enqueue(id: string): void {
    if (this.closed) return;
    const promise = this.queue.enqueue(id).catch((error: unknown) => {
      this.log.error({ err: error, workId: id }, "Reconcile failed");
    }).finally(() => this.pending.delete(promise));
    this.pending.add(promise);
  }

  private async reconcile(id: string): Promise<void> {
    const work = findWork(this.store.read(), id);
    if (work.status !== "ready" && !(work.status === "scheduled" && work.nextAt && Date.parse(work.nextAt) <= Date.now())) return;
    this.store.update((state) => { findWork(state, id).status = "running"; });
    this.due.schedule(id, null);
    this.log.info({ workId: id, kind: work.kind, revision: work.revision }, "Execution started");
    try {
      const result = OutcomeSchema.parse(await this.agent.execute(work));
      if (result.action === "ask" && !result.question?.trim()) throw new Error("ask requires a question");
      if (result.action === "wait" && (!result.nextAt || !Number.isFinite(Date.parse(result.nextAt))
        || Date.parse(result.nextAt) <= Date.now())) throw new Error("wait requires a future nextAt");
      this.store.update((state) => {
        const current = findWork(state, id);
        current.history.push({ at: new Date().toISOString(), role: "aide", text: result.summary });
        // A later user instruction owns the next state; retain the result as evidence from this run.
        if (current.revision !== work.revision) {
          if (current.status !== "paused") current.status = "ready";
        } else if (result.action === "ask") {
          current.status = "waiting";
          current.question = result.question;
          current.nextAt = null;
        } else if (result.action === "wait") {
          current.status = "scheduled";
          current.nextAt = result.nextAt;
        } else {
          current.status = current.kind === "task" ? "done" : "scheduled";
          current.nextAt = nextOccurrence(current.trigger, new Date());
        }
        const text = current.revision === work.revision && result.action === "ask"
          ? result.question : result.notification;
        if (text) state.messages.push(message(current.conversationId, text, id));
      });
      const current = findWork(this.store.read(), id);
      this.log.info({ workId: id, status: current.status }, "Execution recorded");
      this.schedule(current);
    } catch (error) {
      this.store.update((state) => {
        const current = findWork(state, id);
        current.status = "uncertain";
        current.nextAt = null;
        current.history.push({ at: new Date().toISOString(), role: "aide", text: "Execution failed; external effects are unknown. Verify before retrying." });
        state.messages.push(message(current.conversationId,
          `「${current.title}」执行失败，外部操作结果尚不确定。请核对后告诉我是否继续。`, id));
      });
      this.log.error({ err: error, workId: id }, "Execution outcome uncertain");
    }
  }

  /** Wait for currently accepted work, without waiting for future schedules or human answers. */
  async settled(): Promise<void> {
    await this.intake;
    while (this.pending.size) await Promise.all([...this.pending]);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.due.close();
    this.queue.close();
    await this.settled();
  }
}
