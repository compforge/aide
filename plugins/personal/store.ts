import { outputWrite } from "./output.ts";
import { randomUUID } from "node:crypto";
import { PluginResourceStore } from "../../src/host/plugin/resource/store.ts";
import type { ResourceClient, ResourceNamespace, Address } from "@compforge/aide-plugin";
import { WorkSchema, validateTrigger, type OutputDraft, type OutputView, type Work, type WorkStatus } from "./model.ts";
import { ConversationStore } from "./conversation/store.ts";

import { WORK_TYPES, workType, toWork, type WorkResource, type WorkSpec } from "./resources.ts";

/**
 * @spec Task and Routine own business state; their result and independent Outputs commit together.
 * @why Channel retries must never replay business execution. InputStore owns bounded incoming receipts.
 * @link docs/plugin/personal.md
 */
export class Store {
  constructor(readonly resources: PluginResourceStore, readonly client: ResourceClient, readonly conversations: ConversationStore) {}

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

  /** @spec Deleting work retains independent Outputs. In-flight results cannot recreate it. */
  async delete(id: string): Promise<void> {
    const current = this.getResource(id);
    await this.client.delete(current, id, current.metadata.namespace as ResourceNamespace);
  }

  async save(work: Work, outputs: OutputDraft[] = []): Promise<void> {
    WorkSchema.parse(work);
    validateTrigger(work.kind, work.trigger, new Date());
    const { id, conversationId, kind, title, instruction, trigger, revision, uid: _uid, ...observation } = work;
    const type = workType(kind);
    const spec: WorkSpec = { conversationId, title, instruction, revision,
      ...(kind === "routine" ? { trigger: trigger! } : {}) };
    const current = this.findResource(id);
    if (current && current.kind !== type.kind) throw new Error("Work kind is immutable; create the other type and pause or delete the original work");
    const status: WorkStatus = observation;
    const c = await this.conversations.ensure(conversationId);
    await this.client.commit([
      current ? { operation: "replace", resource: current, spec, status } : { operation: "create", type, name: id, spec, status },
      ...outputs.map((o) => outputWrite(c, o, { producer: current ? { ...type, name: id, namespace: current.metadata.namespace, uid: current.metadata.uid }
        : { ...type, name: id, namespace: "v1" } })),
    ]);
  }
}

export function output(conversationId: string, text: string, workId: string | null = null, target?: Address): OutputDraft {
  return { id: randomUUID(), conversationId, text, workId, ...(target ? { target } : {}) };
}
