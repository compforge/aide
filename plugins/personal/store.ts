import { outputWrite } from "./output.ts";
import { outputView } from "../../src/output.ts";
import { randomUUID } from "node:crypto";
import { PluginResourceStore } from "../../src/host/plugin/resource/store.ts";
import type { ResourceClient, ResourceNamespace, Address } from "@compforge/aide-plugin";
import { WorkSchema, validateTrigger, type OutputDraft, type OutputView, type Work, type WorkInput, type WorkStatus, type Delivery } from "./model.ts";
import { ConversationStore } from "./conversation/store.ts";

import { WORK_TYPES, workType, toWork, type WorkResource, type WorkSpec } from "./resources.ts";
const delivery = (): Delivery => ({ inputs: [], events: [] });

/**
 * @spec Task and Routine own business state; their result and independent Outputs commit together.
 * @why Channel retries must never replay business execution. Conversation retains deleted work receipts.
 * @link docs/plugin/personal.md
 */
export class Store {
  constructor(readonly resources: PluginResourceStore, private readonly client: ResourceClient, readonly conversations: ConversationStore) {}

  read(): { works: Work[]; outputs: OutputView[] } {
    const works = this.listResources();
    return {
      works: works.filter((resource) => !resource.metadata.deletionTimestamp).map(toWork),
      outputs: this.conversations.outputs(),
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

  response(key: string): OutputView | undefined {
    const archived = this.conversations.response(key);
    if (archived) return archived;
    for (const resource of this.listResources()) {
      const receipt = resource.status.inputs?.find((input) => input.key === key);
      if (receipt) { const output = this.conversations.outputStore.get(receipt.responseId); if (output) return outputView(output); }
    }
    return undefined;
  }

  hasEvent(id: string, key: string): boolean {
    return this.getResource(id).status.events.includes(key);
  }

  /** @spec Deleting work retains independent Outputs and accepted-input receipts. In-flight results cannot recreate it. */
  async delete(id: string): Promise<void> {
    const current = this.getResource(id);
    await this.conversations.archive(current.spec.conversationId, [], current.status.inputs);
    // Preserve receipts before deletion; independently owned Outputs already survive it.
    await this.client.delete(current, id, current.metadata.namespace as ResourceNamespace);
  }

  async save(work: Work, outputs: OutputDraft[] = [], inputKey?: string, eventKey?: string): Promise<void> {
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
      inputs: [...previous.inputs, ...(inputKey ? [{ key: inputKey, responseId: outputs.at(-1)!.id }] : [])],
      events: [...previous.events, ...(eventKey ? [eventKey] : [])],
    };
    const c = await this.conversations.ensure(conversationId);
    await this.client.commit([
      current ? { operation: "replace", resource: current, spec, status } : { operation: "create", type, name: id, spec, status },
      ...outputs.map((o) => outputWrite(c, o, { producer: current ? { ...type, name: id, namespace: current.metadata.namespace, uid: current.metadata.uid, sessionId: c.spec.sessionId }
        : { ...type, name: id, namespace: "v1", sessionId: c.spec.sessionId } })),
    ]);
  }

  /** @spec Appending an input changes only the Work inbox and revision, never its execution state. */
  async appendInput(id: string, input: WorkInput): Promise<void> {
    const current = this.getResource(id);
    if (current.metadata.deletionTimestamp) throw new Error(`Work ${id} is being deleted`);
    if (current.spec.inputs?.some((item) => item.id === input.id)) return;
    await this.client.replace(current, { ...current.spec, revision: current.spec.revision + 1,
      inputs: [...current.spec.inputs ?? [], input] }, current.status);
  }

  async reply(conversationId: string, outputs: OutputDraft[], key: string): Promise<void> {
    await this.conversations.archive(conversationId, outputs, [{ key, responseId: outputs.at(-1)!.id }]);
  }
}

export function output(conversationId: string, text: string, workId: string | null = null, target?: Address): OutputDraft {
  return { id: randomUUID(), conversationId, text, workId, ...(target ? { target } : {}) };
}
