import { isDeepStrictEqual } from "node:util";
import { workObservation } from "./status.ts";
import { commitStatus } from "./status.ts";
import { resourceRef } from "./input/state.ts";
import type { ResourceRef } from "@compforge/aide-plugin";
import { outputWrite } from "./output.ts";
import { randomUUID } from "node:crypto";
import { PluginResourceStore } from "../../src/host/plugin/resource/store.ts";
import type { ResourceClient, ResourceNamespace, Address } from "@compforge/aide-plugin";
import { WorkSchema, validateTrigger, type OutputDraft, type OutputView, type Work, type WorkStatus } from "./model.ts";
import { TopicStore } from "./topic/store.ts";

import { WORK_TYPES, workType, toWork, type WorkResource, type WorkSpec } from "./resources.ts";

/**
 * @spec Task and Routine own business state; independent Outputs survive work deletion.
 * @why Channel retries must never replay business execution. InputStore owns bounded incoming receipts.
 * @link docs/personal/README.md
 */
export class Store {
  topicId(ref: ResourceRef): string {
    const topic = this.topics.byRef(ref);
    if (!topic) throw new Error(`Work Topic unavailable: ${ref.uid}`);
    return topic.spec.id;
  }
  toWork(resource: WorkResource): Work { return toWork(resource, this.topicId(resource.status.topic)); }
  constructor(readonly resources: PluginResourceStore, readonly client: ResourceClient, readonly topics: TopicStore) {}

  read(): { works: Work[]; outputs: OutputView[] } {
    const works = this.listResources();
    return {
      works: works.filter((resource) => !resource.metadata.deletionTimestamp).map(r => this.toWork(r)),
      outputs: this.topics.outputs(),
    };
  }

  workResources(topicUids: readonly string[]): WorkResource[] {
    return topicUids.flatMap(topicUid => WORK_TYPES.flatMap(type => this.resources.list<WorkSpec, WorkStatus>(type,
      { matchIndex: { name: "topic", value: topicUid } }))).filter(work => !work.metadata.deletionTimestamp);
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

  get(id: string): Work { return this.toWork(this.getResource(id)); }

  /** @spec Deleting work retains independent Outputs. In-flight results cannot recreate it. */
  async delete(id: string): Promise<void> {
    const current = this.getResource(id);
    await this.client.delete(current, id, current.metadata.namespace as ResourceNamespace);
  }

  async save(work: Work, outputs: OutputDraft[] = []): Promise<void> {
    WorkSchema.parse(work);
    validateTrigger(work.kind, work.trigger, new Date());
    const { id, topicId, kind, title, instruction, trigger, revision, uid: _uid, ...observation } = work;
    const type = workType(kind);
    const spec = { title, instruction, paused: work.status === "paused",
      ...(kind === "routine" ? { trigger: trigger! } : {}) };
    const current = this.findResource(id);
    if (current && current.kind !== type.kind) throw new Error("Work kind is immutable; create the other type and pause or delete the original work");
    const c = await this.topics.ensure(topicId);
    const generation = current ? current.metadata.generation + Number(!isDeepStrictEqual({ ...current.spec, ...spec }, current.spec)) : 1;
    const status: WorkStatus = { ...current?.status, ...workObservation(work, generation), topic: resourceRef(c) };
    await commitStatus(this.client, [
      current ? { operation: "replace", resource: current, spec: { ...current.spec, ...spec }, status } : { operation: "create", type, name: id, spec, status },
      ...outputs.map((o) => outputWrite(c, o, { producer: current ? { ...type, name: id, namespace: current.metadata.namespace, uid: current.metadata.uid }
        : { ...type, name: id, namespace: "v1" } })),
    ]);
  }
}

export function output(topicId: string, text: string, workId: string | null = null, target?: Address): OutputDraft {
  return { id: randomUUID(), topicId, text, workId, ...(target ? { target } : {}) };
}
