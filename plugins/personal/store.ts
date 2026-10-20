import { randomUUID } from "node:crypto";
import { PluginResourceStore } from "../../src/host/plugin/resource.ts";
import type { ResourceClient, ResourceNamespace } from "@compforge/aide-plugin";
import { WorkSchema, validateTrigger, type Message, type Work, type WorkInput } from "./model.ts";
import { ConversationStore } from "./conversation-store.ts";

import { WORK_TYPES, workType, toWork, type WorkResource, type WorkSpec, type WorkStatus, type Delivery } from "./resources.ts";
const delivery = (): Delivery => ({ messages: [], inputs: [], events: [] });
let lastMessageTime = 0;

/**
 * @spec Task and Routine Resources own work state and its outbox. ConversationStore owns chat and retains deleted work delivery receipts.
 * @why A per-resource outbox preserves results without a second state store or cross-file transaction.
 * @link docs/plugin/personal.md
 */
export class Store {
  constructor(readonly resources: PluginResourceStore, private readonly client: ResourceClient, readonly conversations: ConversationStore) {
    for (const item of this.read().messages) lastMessageTime = Math.max(lastMessageTime, Date.parse(item.at));
  }

  read(): { works: Work[]; messages: Message[] } {
    const works = this.listResources();
    return {
      works: works.filter((resource) => !resource.metadata.deletionTimestamp).map(toWork),
      messages: [...new Map([...works.flatMap((resource) => resource.status.messages ?? []), ...this.conversations.list().flatMap((item) => item.messages)].map((item) => [item.id, item])).values()]
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
    };
  }

  private listResources(): WorkResource[] {
    return WORK_TYPES.flatMap((type) => this.resources.list<WorkSpec, WorkStatus>(type));
  }

  private findResource(id: string): WorkResource | undefined {
    for (const type of WORK_TYPES) {
      const resource = this.resources.find<WorkSpec, WorkStatus>(type, id);
      if (resource) return resource;
    }
  }

  private getResource(id: string): WorkResource {
    const resource = this.findResource(id);
    if (!resource) throw new Error(`Unknown work: ${id}`);
    return resource;
  }

  get(id: string): Work { return toWork(this.getResource(id)); }

  response(key: string): Message | undefined {
    const archived = this.conversations.response(key);
    if (archived) return archived;
    for (const resource of this.listResources()) {
      const receipt = resource.status.inputs?.find((input) => input.key === key);
      if (receipt) return resource.status.messages.find((item) => item.id === receipt.responseId);
    }
    return undefined;
  }

  hasEvent(id: string, key: string): boolean {
    return this.getResource(id).status.events.includes(key);
  }

  /** @spec Deleting work retains its channel outbox and accepted-input receipts. In-flight results cannot recreate it. */
  async delete(id: string): Promise<void> {
    const current = this.getResource(id);
    await this.conversations.archive(current.spec.conversationId, current.status.messages, current.status.inputs);
    // Archive first: a crash can duplicate retained messages, but cannot lose a receipt.
    await this.client.delete(current, id, current.metadata.namespace as ResourceNamespace);
  }

  async save(work: Work, messages: Message[] = [], inputKey?: string, eventKey?: string): Promise<void> {
    WorkSchema.parse(work);
    validateTrigger(work.kind, work.trigger, new Date());
    const { id, conversationId, kind, title, instruction, trigger, revision, inputs: workInputs, ...observation } = work;
    const type = workType(kind);
    const spec: WorkSpec = { conversationId, title, instruction, revision, inputs: workInputs,
      ...(kind === "routine" ? { trigger: trigger! } : {}) };
    const current = this.findResource(id);
    if (current && current.kind !== type.kind) throw new Error("Work kind is immutable; create the other type and pause or delete the original work");
    const previous = current?.status ?? delivery();
    const status: WorkStatus = { ...observation,
      ...(current?.status.laneId ? { laneId: current.status.laneId } : {}),
      messages: [...previous.messages, ...messages],
      inputs: [...previous.inputs, ...(inputKey ? [{ key: inputKey, responseId: messages.at(-1)!.id }] : [])],
      events: [...previous.events, ...(eventKey ? [eventKey] : [])],
    };
    if (current) await this.client.replace(current, spec, status);
    else await this.client.create(type, { name: id, spec, status });
  }

  /** @spec Appending an input changes only the Work inbox and revision, never its execution state. */
  async appendInput(id: string, input: WorkInput): Promise<void> {
    const current = this.getResource(id);
    if (current.metadata.deletionTimestamp) throw new Error(`Work ${id} is being deleted`);
    if (current.spec.inputs?.some((item) => item.id === input.id)) return;
    await this.client.replace(current, { ...current.spec, revision: current.spec.revision + 1,
      inputs: [...current.spec.inputs ?? [], input] }, current.status);
  }

  async reply(conversationId: string, messages: Message[], key: string): Promise<void> {
    await this.conversations.archive(conversationId, messages, [{ key, responseId: messages.at(-1)!.id }]);
  }
}

export function message(conversationId: string, text: string, workId: string | null = null): Message {
  // Preserve append order across per-resource outboxes and process restarts, including same-ms replies.
  lastMessageTime = Math.max(Date.now(), lastMessageTime + 1);
  return { id: randomUUID(), conversationId, text, workId, at: new Date(lastMessageTime).toISOString(), role: "aide" };
}
