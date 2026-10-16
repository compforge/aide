import { createHash, randomUUID } from "node:crypto";
import { PluginResourceStore } from "../runtime/plugin/resource.ts";
import type { ResourceClientChange } from "../runtime/plugin/resource-client.ts";
import { WorkSchema, type Message, type Work } from "./model.ts";

export { WORK_TYPE, toWork, type WorkResource } from "./resources.ts";
import { WORK_TYPE, CONVERSATION_TYPE, toWork, type WorkSpec, type WorkStatus, type Delivery } from "./resources.ts";
const delivery = (): Delivery => ({ messages: [], inputs: [], events: [] });
let lastMessageTime = 0;

/**
 * @spec Work Resources are the sole work-state authority. Replies and input receipts commit in the same Resource.
 * @why A per-resource outbox preserves results without a second state store or cross-file transaction.
 * @link docs/runtime.md
 */
export class Store {
  constructor(readonly resources: PluginResourceStore, private readonly changed: (change: ResourceClientChange) => void) {
    for (const item of this.read().messages) lastMessageTime = Math.max(lastMessageTime, Date.parse(item.at));
  }

  read(): { works: Work[]; messages: Message[] } {
    const works = this.resources.list<WorkSpec, WorkStatus>(WORK_TYPE);
    const conversations = this.resources.list<{ conversationId: string }, Delivery>(CONVERSATION_TYPE);
    return {
      works: works.map(toWork),
      messages: [...works, ...conversations].flatMap((resource) => resource.status.messages ?? [])
        .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id)),
    };
  }

  get(id: string): Work { return toWork(this.resources.get<WorkSpec, WorkStatus>(WORK_TYPE, id)); }

  response(key: string): Message | undefined {
    for (const type of [WORK_TYPE, CONVERSATION_TYPE]) {
      for (const resource of this.resources.list<unknown, Delivery>(type)) {
        const receipt = resource.status.inputs?.find((input) => input.key === key);
        if (receipt) return resource.status.messages.find((item) => item.id === receipt.responseId);
      }
    }
    return undefined;
  }

  hasEvent(id: string, key: string): boolean {
    return this.resources.get<WorkSpec, WorkStatus>(WORK_TYPE, id).status.events.includes(key);
  }

  save(work: Work, messages: Message[] = [], inputKey?: string, eventKey?: string): void {
    WorkSchema.parse(work);
    const { id, conversationId, kind, title, instruction, trigger, revision, ...observation } = work;
    const spec = { conversationId, kind, title, instruction, trigger, revision };
    const current = this.resources.find<WorkSpec, WorkStatus>(WORK_TYPE, id);
    const previous = current?.status ?? delivery();
    const status: WorkStatus = { ...observation,
      ...(current?.status.laneId ? { laneId: current.status.laneId } : {}),
      messages: [...previous.messages, ...messages],
      inputs: [...previous.inputs, ...(inputKey ? [{ key: inputKey, responseId: messages.at(-1)!.id }] : [])],
      events: [...previous.events, ...(eventKey ? [eventKey] : [])],
    };
    const resource = current ? this.replace(current, spec, status)
      : this.resources.create({ type: WORK_TYPE, name: id, spec, status });
    if (!current) this.changed({ kind: "created", pluginInstanceId: this.resources.pluginInstanceId, resource });
    else if (resource.metadata.resourceVersion !== current.metadata.resourceVersion) {
      this.changed({ kind: "status-updated", pluginInstanceId: this.resources.pluginInstanceId, oldResource: current, resource });
    }
  }

  private replace<S, T>(current: import("@compforge/baton-plugin").Resource<S, T>, spec: S, status: T) {
    const desired = this.resources.replaceSpec(current, current.metadata.name, spec,
      { expectedResourceVersion: current.metadata.resourceVersion });
    return this.resources.patchStatus<S, T>(desired, desired.metadata.name, status,
      { expectedResourceVersion: desired.metadata.resourceVersion });
  }

  reply(conversationId: string, messages: Message[], key: string): void {
    const name = createHash("sha256").update(conversationId).digest("hex");
    const current = this.resources.find<{ conversationId: string }, Delivery>(CONVERSATION_TYPE, name);
    const previous = current?.status ?? delivery();
    const status = { ...previous, messages: [...previous.messages, ...messages],
      inputs: [...previous.inputs, { key, responseId: messages.at(-1)!.id }],
    };
    if (current) this.replace(current, current.spec, status);
    else this.resources.create({ type: CONVERSATION_TYPE, name, spec: { conversationId }, status });
  }
}

export function message(conversationId: string, text: string, workId: string | null = null): Message {
  // Preserve append order across per-resource outboxes and process restarts, including same-ms replies.
  lastMessageTime = Math.max(Date.now(), lastMessageTime + 1);
  return { id: randomUUID(), conversationId, text, workId, at: new Date(lastMessageTime).toISOString(), role: "aide" };
}
