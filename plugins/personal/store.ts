import { randomUUID } from "node:crypto";
import { PluginResourceStore } from "../../src/host/plugin/resource.ts";
import type { ResourceClientChange } from "../../src/host/plugin/resource-client.ts";
import { WorkSchema, validateTrigger, type Message, type Work } from "./model.ts";
import { ConversationStore } from "../../src/host/conversation/store.ts";

import { WORK_TYPES, workType, toWork, type WorkResource, type WorkSpec, type WorkStatus, type Delivery } from "./resources.ts";
const delivery = (): Delivery => ({ messages: [], inputs: [], events: [] });
let lastMessageTime = 0;

/**
 * @spec Task and Routine Resources own work state and its outbox. ConversationStore owns chat and retains deleted work delivery receipts.
 * @why A per-resource outbox preserves results without a second state store or cross-file transaction.
 * @link docs/plugin/personal.md
 */
export class Store {
  constructor(readonly resources: PluginResourceStore, private readonly changed: (change: ResourceClientChange) => void, readonly conversations: ConversationStore) {
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
  delete(id: string): void {
    const current = this.getResource(id);
    this.conversations.archive(current.spec.conversationId, current.status.messages, current.status.inputs);
    // Archive first: a crash can duplicate retained messages, but cannot lose a receipt.
    for (const update of this.resources.requestDeletion(current, id)) {
      this.changed({ kind: "deletion-requested", pluginInstanceId: this.resources.pluginInstanceId, ...update });
    }
  }

  save(work: Work, messages: Message[] = [], inputKey?: string, eventKey?: string): void {
    WorkSchema.parse(work);
    validateTrigger(work.kind, work.trigger, new Date());
    const { id, conversationId, kind, title, instruction, trigger, revision, ...observation } = work;
    const type = workType(kind);
    const spec: WorkSpec = { conversationId, title, instruction, revision,
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
    const resource = current ? this.replace(current, spec, status)
      : this.resources.create({ type, name: id, spec, status });
    if (!current) this.changed({ kind: "created", pluginInstanceId: this.resources.pluginInstanceId, resource });
    else if (resource.metadata.resourceVersion !== current.metadata.resourceVersion) {
      this.changed({ kind: "status-updated", pluginInstanceId: this.resources.pluginInstanceId, oldResource: current, resource });
    }
  }

  private replace<S, T>(current: import("@compforge/aide-plugin").Resource<S, T>, spec: S, status: T) {
    const desired = this.resources.replaceSpec(current, current.metadata.name, spec,
      { expectedResourceVersion: current.metadata.resourceVersion });
    return this.resources.patchStatus<S, T>(desired, desired.metadata.name, status,
      { expectedResourceVersion: desired.metadata.resourceVersion });
  }

  reply(conversationId: string, messages: Message[], key: string): void {
    this.conversations.archive(conversationId, messages, [{ key, responseId: messages.at(-1)!.id }]);
  }
}

export function message(conversationId: string, text: string, workId: string | null = null): Message {
  // Preserve append order across per-resource outboxes and process restarts, including same-ms replies.
  lastMessageTime = Math.max(Date.now(), lastMessageTime + 1);
  return { id: randomUUID(), conversationId, text, workId, at: new Date(lastMessageTime).toISOString(), role: "aide" };
}
