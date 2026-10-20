import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Logger } from "pino";
import { TriggerSchema, nextOccurrence, validateTrigger, type Work } from "./model.ts";
import { digest } from "./chief-model.ts";
import type { Store } from "./store.ts";

export const WorkDefinitionSchema = z.object({
  kind: z.enum(["task", "routine"]), title: z.string().trim().min(1),
  instruction: z.string().trim().min(1), trigger: TriggerSchema.nullable(),
}).strict();
export type WorkDefinition = z.infer<typeof WorkDefinitionSchema>;
export const AppendInputSchema = z.object({
  inputId: z.string().min(1).optional(),
  text: z.string().trim().min(1).optional(),
  action: z.enum(["context", "update", "pause", "resume", "answer"]).default("context"),
  changes: WorkDefinitionSchema.omit({ kind: true }).partial().optional(),
}).strict().refine((v) => v.inputId || v.text, "append_input requires inputId or text")
  .refine((v) => v.action === "update" ? v.changes && Object.keys(v.changes).length > 0 : !v.changes,
    "Only an update request accepts and requires changes");
export type AppendInput = z.input<typeof AppendInputSchema>;

export function newWork(conversationId: string, definition: WorkDefinition, now = new Date()): Work {
  const desired = WorkDefinitionSchema.parse(definition);
  validateTrigger(desired.kind, desired.trigger, now);
  return { id: randomUUID(), conversationId, ...desired,
    status: desired.kind === "routine" ? "scheduled" : "ready", revision: 1,
    nextAt: nextOccurrence(desired.trigger, now), question: null, inputs: [], consumedInputIds: [], history: [] };
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
    await this.store.conversations.ensure(this.conversationId);
    await this.store.save(work);
    this.log.info({ workId: work.id, conversationId: this.conversationId, kind: work.kind }, "Work tool created work");
    return work;
  }

  async appendInput(id: string, request: AppendInput, key?: string): Promise<Work> {
    const work = this.read(id);
    const input = AppendInputSchema.parse(request);
    const original = input.inputId ? this.store.conversations.input(input.inputId, this.conversationId) : undefined;
    if (input.inputId && !original) throw new Error("Input does not belong to this conversation");
    if (original?.spec.origin === "source" && input.action !== "context") throw new Error("Source facts cannot be control requests");
    const identity = digest([id, input.inputId ?? key ?? randomUUID(), input.action]);
    await this.store.appendInput(work.id, { id: identity, at: new Date().toISOString(),
      ...(input.inputId ? { inputId: input.inputId } : {}), origin: original?.spec.origin ?? "chief",
      ...(original?.spec.observation ? { observation: original.spec.observation } : {}),
      text: original?.spec.text ?? input.text!, ...(original && input.text ? { note: input.text } : {}),
      action: input.action, ...(input.changes ? { changes: input.changes } : {}) });
    this.log.info({ workId: id, inputId: input.inputId, workInputId: identity, conversationId: this.conversationId }, "Appended work input");
    return this.read(id);
  }

  async delete(id: string, revision: number): Promise<void> {
    const work = this.read(id);
    if (work.revision !== revision) throw new Error(`Work ${id} revision changed; read it again before deleting`);
    await this.store.delete(id);
    this.log.info({ workId: id, conversationId: this.conversationId, kind: work.kind, revision }, "Deleted work");
  }
}
