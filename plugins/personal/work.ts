import { isDeepStrictEqual } from "node:util";
import { INPUT_TYPE } from "./input/model.ts";
import { resourceRef } from "./input/state.ts";
import { WorkInputRequestSchema } from "./model.ts";
import { workType } from "./resources.ts";
import { digest } from "./chief-model.ts";
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
export function newWork(conversationId: string, definition: WorkDefinition, now = new Date()): Work {
  const desired = WorkDefinitionSchema.parse(definition);
  validateTrigger(desired.kind, desired.trigger, now);
  return { id: randomUUID(), conversationId, ...desired,
    status: desired.kind === "routine" ? "scheduled" : "ready", revision: 1,
    nextAt: nextOccurrence(desired.trigger, now), question: null, summary: "", recent: [] };
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

  async createInput(text: string, key: string = randomUUID()): Promise<{ inputId: string }> {
    const content = z.string().trim().min(1).max(32000).parse(text);
    const conversation = await this.store.conversations.ensure(this.conversationId);
    const inputId = digest([conversation.metadata.uid, "chief-input", key]);
    const at = new Date().toISOString();
    await this.store.client.create(INPUT_TYPE, { name: inputId,
      spec: { origin: "chief", originId: "personal.chief", text: content, sessionId: this.conversationId }, status: {
        route: { completedAt: at, result: { conversations: [resourceRef(conversation)], reason: "Independent Chief decision" } },
        assess: { [conversation.metadata.uid]: { resource: resourceRef(conversation), assignedAt: at, completedAt: at, result: { summary: content } } },
      } });
    this.log.info({ inputId, conversationId: this.conversationId }, "Chief decision recorded");
    return { inputId };
  }

  async create(definition: WorkDefinition, inputId?: string, key: string = randomUUID()): Promise<Work> {
    const work = newWork(this.conversationId, definition);
    await this.store.conversations.ensure(this.conversationId);
    if (work.kind === "task") {
      const conversation = this.store.conversations.resource(this.conversationId)!;
      const initialInputId = inputId ?? digest([conversation.metadata.uid, "chief-task", key]);
      work.id = digest([conversation.metadata.uid, initialInputId, key]);
      const at = new Date().toISOString();
      await this.store.client.commit([
        ...(!inputId ? [{ operation: "create" as const, type: INPUT_TYPE, name: initialInputId,
          spec: { origin: "chief", originId: "personal.chief", text: work.instruction, sessionId: this.conversationId }, status: {
            route: { completedAt: at, result: { conversations: [resourceRef(conversation)], reason: "Independent Chief task" } },
            assess: { [conversation.metadata.uid]: { resource: resourceRef(conversation), assignedAt: at, completedAt: at, result: { summary: work.instruction } } },
          } }] : []),
        { operation: "create", type: workType("task"), name: work.id,
          spec: { conversationId: work.conversationId, title: work.title, instruction: work.instruction, revision: work.revision, initialInputId },
          status: { status: "ready", nextAt: null, question: null, summary: "", recent: [] } },
      ]);
    } else await this.store.save(work);
    this.log.info({ workId: work.id, conversationId: this.conversationId, kind: work.kind }, "Work tool created work");
    return this.read(work.id);
  }

  /** @spec An independent Chief request gets a new Input identity; it cannot reopen a previous handle receipt. */
  async requestInput(id: string, raw: { text: string; action?: "context" | "update" | "pause" | "resume" | "answer"; changes?: import("./model.ts").WorkInputRequest["changes"] }, key: string = randomUUID()) {
    const work = this.read(id);
    const { text, ...request } = z.object({ text: z.string().min(1).max(32000) }).passthrough().parse(raw);
    const parsed = WorkInputRequestSchema.parse(request);
    const target = this.store.resources.get(workType(work.kind), id);
    if (target.metadata.deletionTimestamp) throw new Error("Work is being deleted");
    const c = this.store.conversations.resource(this.conversationId)!;
    const at = new Date().toISOString();
    const name = digest([target.metadata.uid, key]);
    const previous = this.store.conversations.inputStore.get(name);
    if (previous && !isDeepStrictEqual(previous.status.handle?.[target.metadata.uid]?.request, parsed)) throw new Error("Input already has a different Work request; use a new identity");
    await this.store.client.commit([
      { operation: "patchStatus", resource: target, patch: { idleSince: null, agentStoppedAt: null } },
      { operation: "create", type: INPUT_TYPE, name, spec: { origin: "chief", originId: "personal.chief", text, sessionId: c.spec.id, observation: { work: resourceRef(target), request: parsed } }, status: {
        route: { completedAt: at, result: { conversations: [resourceRef(c)], reason: "Independent Chief request" } },
        assess: { [c.metadata.uid]: { resource: resourceRef(c), assignedAt: at, completedAt: at, result: { summary: text } } },
        handle: { [target.metadata.uid]: { resource: resourceRef(target), assignedAt: at, request: parsed } },
      } },
    ]);
    this.log.info({ inputId: name, workId: id, workUid: target.metadata.uid, conversationId: this.conversationId, action: parsed.action }, "Chief request assigned to Work");
    return this.read(id);
  }

  async delete(id: string, revision: number): Promise<void> {
    const work = this.read(id);
    if (work.revision !== revision) throw new Error(`Work ${id} revision changed; read it again before deleting`);
    await this.store.delete(id);
    this.log.info({ workId: id, conversationId: this.conversationId, kind: work.kind, revision }, "Deleted work");
  }
}
