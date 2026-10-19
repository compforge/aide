import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "pino";
import { TriggerSchema, nextOccurrence, validateTrigger, type Work } from "./model.ts";
import type { Store } from "./store.ts";

export const WorkDefinitionSchema = z.object({
  kind: z.enum(["task", "routine"]), title: z.string().trim().min(1),
  instruction: z.string().trim().min(1), trigger: TriggerSchema.nullable(),
}).strict();
export type WorkDefinition = z.infer<typeof WorkDefinitionSchema>;
export const WorkUpdateSchema = z.object({
  revision: z.number().int().positive(),
  action: z.enum(["update", "pause", "resume", "answer"]),
  changes: WorkDefinitionSchema.omit({ kind: true }).partial().optional(),
  note: z.string().trim().min(1).optional(),
}).strict();
export type WorkUpdate = z.infer<typeof WorkUpdateSchema>;

export function newWork(conversationId: string, definition: WorkDefinition, now = new Date()): Work {
  const desired = WorkDefinitionSchema.parse(definition);
  validateTrigger(desired.kind, desired.trigger, now);
  return { id: randomUUID(), conversationId, ...desired,
    status: desired.kind === "routine" ? "scheduled" : "ready", revision: 1,
    nextAt: nextOccurrence(desired.trigger, now), question: null, history: [] };
}

/** @spec User changes preserve resource kind and identity; only the reconciler can declare execution complete. */
export function changeWork(work: Work, update: WorkUpdate, now = new Date()): Work {
  const request = WorkUpdateSchema.parse(update);
  if (request.revision !== work.revision) throw new Error(`Work ${work.id} revision changed; read it again before updating`);
  const next = structuredClone(work);
  if (request.action === "update") {
    if (!request.changes || !Object.keys(request.changes).length) throw new Error("update requires changes");
    const { kind, title, instruction, trigger } = work;
    const desired = WorkDefinitionSchema.parse({ kind, title, instruction, trigger, ...request.changes });
    Object.assign(next, desired);
    validateTrigger(next.kind, next.trigger, now);
    if (next.status !== "running") {
      next.status = next.kind === "routine" ? "scheduled" : "ready";
      next.nextAt = nextOccurrence(next.trigger, now);
    }
  } else {
    if (request.changes) throw new Error("Only update accepts changes");
    if (request.action === "pause") { next.status = "paused"; next.nextAt = null; }
    else {
      if (request.action === "answer" && (next.status !== "waiting" || !request.note)) {
        throw new Error("answer requires waiting work and a non-empty note");
      }
      if (next.status !== "running") next.status = "ready";
      next.nextAt = null;
    }
  }
  next.question = null; next.revision++;
  if (request.note) next.history.push({ at: now.toISOString(), role: "user", text: request.note });
  return next;
}

/**
 * @spec Tools operate on the caller-bound conversation, never a model-supplied scope. Writes notify all matching resource watches.
 * @link docs/plugin/personal.md
 */
export class WorkService {
  constructor(private readonly store: Store, readonly conversationId: string, private readonly log: Logger) {
    if (!conversationId.trim()) throw new Error("Work tools require a conversationId");
  }

  list(): Work[] { return this.store.read().works.filter((work) => work.conversationId === this.conversationId); }

  read(id: string): Work {
    const work = this.list().find((item) => item.id === id);
    if (!work) throw new Error(`Unknown work in this conversation: ${id}`);
    return work;
  }

  async create(definition: WorkDefinition): Promise<Work> {
    const work = newWork(this.conversationId, definition);
    await this.store.save(work);
    this.log.info({ workId: work.id, conversationId: this.conversationId, kind: work.kind }, "Work tool created work");
    return work;
  }

  async update(id: string, request: WorkUpdate): Promise<Work> {
    const work = changeWork(this.read(id), request);
    await this.store.save(work);
    this.log.info({ workId: id, revision: work.revision, action: request.action }, "Work tool updated work");
    return work;
  }

  async delete(id: string, revision: number): Promise<void> {
    const work = this.read(id);
    if (work.revision !== revision) throw new Error(`Work ${id} revision changed; read it again before deleting`);
    await this.store.delete(id);
    this.log.info({ workId: id, revision }, "Work tool deleted work");
  }
}
