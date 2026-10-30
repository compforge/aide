import { commitStatus } from "./status.ts";
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
export function newWork(topicId: string, definition: WorkDefinition, now = new Date()): Work {
  const desired = WorkDefinitionSchema.parse(definition);
  validateTrigger(desired.kind, desired.trigger, now);
  return { id: randomUUID(), topicId, ...desired,
    conditions: [], status: desired.kind === "routine" ? "scheduled" : "ready", revision: 1,
    nextAt: nextOccurrence(desired.trigger, now), question: null, summary: "", summaryUid: "", summaryRevision: "", recent: [] };
}

/**
 * @spec Work starts in its creating Chief Topic; explicit organization may move idle ownership. Writes notify all matching resource watches.
 * @link docs/personal/README.md
 */
export class WorkService {
  constructor(private readonly store: Store, readonly topicId: string, private readonly log: Logger) {
    if (!topicId.trim()) throw new Error("Work tools require a topicId");
  }

  list(): Work[] {
    const topic = this.store.topics.resource(this.topicId);
    return this.store.workResources(topic ? this.store.topics.scope(topic.metadata.uid).map(t => t.metadata.uid) : []).map(r => this.store.toWork(r));
  }

  read(id: string): Work {
    const work = this.list().find((item) => item.id === id);
    if (!work) throw new Error(`Unknown work in this topic: ${id}`);
    return work;
  }

  async createInput(text: string, key: string = randomUUID()): Promise<{ inputId: string }> {
    const content = z.string().trim().min(1).max(32000).parse(text);
    const topic = await this.store.topics.ensure(this.topicId);
    const inputId = digest([topic.metadata.uid, "chief-input", key]);
    const at = new Date().toISOString();
    await this.store.client.create(INPUT_TYPE, { name: inputId,
      spec: { origin: "chief", originId: "personal.chief", text: content, topicId: this.topicId }, status: {
        topic: resourceRef(topic),
        route: { completedAt: at, result: { topics: [resourceRef(topic)], reason: "Independent Chief decision" } },
        assess: { completedAt: at, result: { summary: content } },
      } });
    this.log.info({ inputId, topicId: this.topicId }, "Chief decision recorded");
    return { inputId };
  }

  async create(definition: WorkDefinition, inputId?: string, key: string = randomUUID()): Promise<Work> {
    const work = newWork(this.topicId, definition);
    await this.store.topics.ensure(this.topicId);
    if (work.kind === "task") {
      const topic = this.store.topics.resource(this.topicId)!;
      const initialInputId = inputId ?? digest([topic.metadata.uid, "chief-task", key]);
      work.id = digest([topic.metadata.uid, initialInputId, key]);
      const at = new Date().toISOString();
      await commitStatus(this.store.client, [
        ...(!inputId ? [{ operation: "create" as const, type: INPUT_TYPE, name: initialInputId,
          spec: { origin: "chief", originId: "personal.chief", text: work.instruction, topicId: this.topicId }, status: {
            topic: resourceRef(topic),
            route: { completedAt: at, result: { topics: [resourceRef(topic)], reason: "Independent Chief task" } },
            assess: { completedAt: at, result: { summary: work.instruction } },
          } }] : []),
        { operation: "create", type: workType("task"), name: work.id,
          spec: { title: work.title, instruction: work.instruction, paused: false, initialInputId },
          status: { topic: resourceRef(topic), waiting: null } },
      ]);
    } else await this.store.save(work);
    this.log.info({ workId: work.id, topicId: this.topicId, kind: work.kind }, "Work tool created work");
    return this.read(work.id);
  }

  /** @spec An independent Chief request gets a new Input identity; it cannot reopen a previous handle receipt. */
  async requestInput(id: string, raw: { text: string; action?: "context" | "update" | "pause" | "resume" | "answer"; changes?: import("./model.ts").WorkInputRequest["changes"] }, key: string = randomUUID()) {
    const work = this.read(id);
    const { text, ...request } = z.object({ text: z.string().min(1).max(32000) }).passthrough().parse(raw);
    const parsed = WorkInputRequestSchema.parse(request);
    const target = this.store.resources.get(workType(work.kind), id);
    if (target.metadata.deletionTimestamp) throw new Error("Work is being deleted");
    const c = this.store.topics.resource(this.topicId)!;
    const at = new Date().toISOString();
    const name = digest([target.metadata.uid, key]);
    const previous = this.store.topics.inputStore.get(name);
    if (previous && !isDeepStrictEqual(previous.status.handle?.[target.metadata.uid]?.request, parsed)) throw new Error("Input already has a different Work request; use a new identity");
    await commitStatus(this.store.client, [
      { operation: "patchStatus", resource: target, patch: { idleSince: null, agentStoppedAt: null } },
      { operation: "create", type: INPUT_TYPE, name, spec: { origin: "chief", originId: "personal.chief", text, topicId: c.spec.id, observation: { work: resourceRef(target), request: parsed } }, status: {
        topic: resourceRef(c),
        route: { completedAt: at, result: { topics: [resourceRef(c)], reason: "Independent Chief request" } },
        assess: { completedAt: at, result: { summary: text } },
        handle: { [target.metadata.uid]: { resource: resourceRef(target), assignedAt: at, request: parsed } },
      } },
    ]);
    this.log.info({ inputId: name, workId: id, workUid: target.metadata.uid, topicId: this.topicId, action: parsed.action }, "Chief request assigned to Work");
    return this.read(id);
  }

  async delete(id: string, revision: number): Promise<void> {
    const work = this.read(id);
    if (work.revision !== revision) throw new Error(`Work ${id} revision changed; read it again before deleting`);
    await this.store.delete(id);
    this.log.info({ workId: id, topicId: this.topicId, kind: work.kind, revision }, "Deleted work");
  }
}
