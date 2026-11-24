import { ongoingView, ONGOING_TYPE, type OngoingSpec, type OngoingStatus } from "../ongoing/model.ts";
import { upsertOngoing } from "../ongoing/service.ts";
import { readTopicInScope } from "../topic/tree.ts";
import { isGateTopic } from "../topic/boundary.ts";
import { commitStatus } from "../status.ts";
import { isDeepStrictEqual } from "node:util";
import type { TopicResource } from "../topic/model.ts";
import { INPUT_TYPE, isInternalInput, type InputStatus } from "../input/model.ts";
import { resourceRef } from "../input/state.ts";
import { WorkInputRequestSchema } from "./model.ts";
import { workType } from "./resources.ts";
import { digest } from "../identity.ts";
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
type OngoingDefinition = { kind: "ongoing"; title: string; progress?: string; question?: string; checkAt?: string };
const decisionText = z.string().trim().min(1).max(32000);
const appendMaterial = z.object({ id: z.string().min(1).optional(), text: decisionText.optional() }).strict()
  .refine(input => input.id !== undefined || input.text !== undefined, "Supply input.id or input.text");

function chiefDecision(topic: TopicResource, text: string, at: string) {
  const ref = resourceRef(topic);
  return {
    spec: { origin: "chief" as const, originId: isGateTopic(topic) ? "personal.gate" : "personal.chief", text, topicId: topic.spec.id },
    status: { topic: ref, route: { completedAt: at, result: { topics: [ref], reason: "Independent Chief decision" } },
      assess: { completedAt: at, result: { summary: text } } },
  };
}
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

  private scope() {
    const topic = this.store.topics.resource(this.topicId);
    return topic ? this.store.topics.scope(topic.metadata.uid).map(t => t.metadata.uid) : [];
  }

  list(): Work[] {
    return this.store.workResources(this.scope()).map(r => this.store.toWork(r));
  }

  listItems(kind?: Work["kind"] | "ongoing", includeClosed = false) {
    const scope = this.scope();
    const delegated = kind === "ongoing" ? [] : this.store.workResources(scope).map(r => this.store.toWork(r)).filter(w => !kind || w.kind === kind);
    const ongoing = kind && kind !== "ongoing" ? [] : this.store.ongoingResources(scope, includeClosed).map(ongoingView);
    return [...delegated, ...ongoing];
  }

  async readItem(id: string) {
    const matter = this.store.resources.find<OngoingSpec, OngoingStatus>(ONGOING_TYPE, id);
    if (!matter) return this.read(id);
    const actor = this.store.topics.resource(this.topicId);
    if (!actor || matter.metadata.deletionTimestamp || !await readTopicInScope(this.store.client, actor, matter.spec.topic.uid))
      throw new Error("Ongoing is unavailable in this Topic");
    return ongoingView(matter);
  }

  read(id: string): Work {
    const work = this.list().find((item) => item.id === id);
    if (!work) throw new Error(`Unknown work in this topic: ${id}`);
    return work;
  }

  async createInput(text: string, key: string = randomUUID()): Promise<{ inputId: string }> {
    const content = decisionText.parse(text);
    const topic = await this.store.topics.ensure(this.topicId);
    const inputId = digest([topic.metadata.uid, "chief-input", key]);
    await this.store.client.create(INPUT_TYPE, { name: inputId, ...chiefDecision(topic, content, new Date().toISOString()) });
    this.log.info({ inputId, topicId: this.topicId }, "Chief decision recorded");
    return { inputId };
  }

  async create(definition: WorkDefinition, inputId?: string, key?: string): Promise<Work>;
  async create(definition: OngoingDefinition, inputId?: undefined, key?: string): Promise<ReturnType<typeof ongoingView>>;
  async create(definition: WorkDefinition | OngoingDefinition, inputId?: string, key: string = randomUUID()) {
    if (definition.kind === "ongoing") {
      if (inputId) throw new Error("Ongoing stays with Chief and cannot take an Input handle");
      const actor = this.store.topics.resource(this.topicId);
      if (!actor) throw new Error("Ongoing requires an active domain Chief");
      const { kind, ...plan } = definition;
      const matter = await upsertOngoing(this.store.client, actor, plan, key);
      this.log.info({ workId: matter.id, topicId: this.topicId, kind }, "Work tool created work");
      return matter;
    }
    const work = newWork(this.topicId, definition);
    await this.store.topics.ensure(this.topicId);
    if (work.kind === "task") {
      const topic = this.store.topics.resource(this.topicId)!;
      const initialInputId = inputId ?? digest([topic.metadata.uid, "chief-task", key]);
      work.id = digest([topic.metadata.uid, initialInputId, key]);
      const at = new Date().toISOString();
      await commitStatus(this.store.client, [
        ...(!inputId ? [{ operation: "create" as const, type: INPUT_TYPE, name: initialInputId,
          ...chiefDecision(topic, work.instruction, at) }] : []),
        { operation: "create", type: workType("task"), name: work.id,
          spec: { title: work.title, instruction: work.instruction, paused: false, initialInputId },
          status: { topic: resourceRef(topic), waiting: null } },
      ]);
    } else await this.store.save(work);
    this.log.info({ workId: work.id, topicId: this.topicId, kind: work.kind }, "Work tool created work");
    return this.read(work.id);
  }

  /** @spec A Task or Routine receives an original Input once. Concurrent appends retain each recipient's receipt.
   * @link docs/personal/input.md#研判与办理
   */
  async appendInput(id: string, material: z.input<typeof appendMaterial>, raw: z.input<typeof WorkInputRequestSchema> = {}, key: string = randomUUID()) {
    const request = WorkInputRequestSchema.parse(raw);
    const actor = this.store.topics.resource(this.topicId);
    if (!actor) throw new Error("Work Topic is unavailable");
    const { id: suppliedId, text } = appendMaterial.parse(material);
    const inputId = suppliedId ?? digest([actor.metadata.uid, "chief-input", key]);
    const at = new Date().toISOString();
    const draft = text === undefined ? undefined : chiefDecision(actor, text, at);
    for (let attempt = 0; ; attempt++) {
      const work = this.read(id);
      const target = this.store.resources.get(workType(work.kind), id);
      const input = this.store.topics.inputStore.get(inputId);
      if (input) {
        if (input.metadata.deletionTimestamp || !input.status.topic || !this.scope().includes(input.status.topic.uid))
          throw new Error("Input is unavailable in this Topic");
        if (draft && (input.spec.origin !== draft.spec.origin || input.spec.originId !== draft.spec.originId ||
          input.spec.topicId !== draft.spec.topicId || input.spec.text !== draft.spec.text))
          throw new Error("Input identity already exists with different content or owner");
        if (isInternalInput(input.spec)) throw new Error("Maintenance Input cannot be delegated");
        if (input.spec.origin === "source" && request.action !== "context") throw new Error("Source facts cannot be control requests");
      } else if (!draft || this.store.topics.inputStore.receipt(inputId)) throw new Error(`Input missing: ${inputId}`);
      const previous = input?.status.handle?.[target.metadata.uid];
      if (previous) {
        if (!isDeepStrictEqual(previous.request, request)) throw new Error("Input already has a different Work request");
        return { ...work, inputId };
      }
      const handle = { ...input?.status.handle, [target.metadata.uid]: { resource: resourceRef(target), assignedAt: at, request } };
      try {
        const [, saved] = await commitStatus(this.store.client, [
          { operation: "patchStatus", resource: target, patch: { idleSince: null, agentStoppedAt: null } },
          input ? { operation: "patchStatus", resource: input, patch: { handle } }
            : { operation: "create", type: INPUT_TYPE, name: inputId, spec: draft!.spec, status: { ...draft!.status, handle } },
        ]);
        // Admission can return another caller’s identical Input. Append to that version if it has other recipients.
        if (!input && !isDeepStrictEqual((saved?.status as InputStatus)?.handle?.[target.metadata.uid]?.request, request)) {
          if (attempt >= 8) throw new Error("Concurrent Input append did not settle");
          continue;
        }
      } catch (error) {
        if (attempt >= 8 || !/version conflict/.test(String(error))) throw error;
        continue;
      }
      this.log.info({ inputId, workId: id, topicId: this.topicId, action: request.action }, "Input appended to Work");
      return { ...this.read(id), inputId };
    }
  }

  async delete(id: string, revision: number): Promise<void> {
    const work = this.read(id);
    if (work.revision !== revision) throw new Error(`Work ${id} revision changed; read it again before deleting`);
    await this.store.delete(id);
    this.log.info({ workId: id, topicId: this.topicId, kind: work.kind, revision }, "Deleted work");
  }
}
