import { patchStatus } from "../status.ts";
import type { Resource, ResourceClient, ResourceRef, Watch } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus, type Attempt } from "./model.ts";
import type { TopicResource } from "../topic/model.ts";
import { readTopicSubtree, readTopicRoot } from "../topic/tree.ts";
export type Input = Readonly<Resource<InputSpec, InputStatus>>;
export const inputRef = (name: string) => ({ ...INPUT_TYPE, namespace: "v1" as const, name });
export const resourceRef = (r: Readonly<Resource<unknown, unknown>>) => ({ apiVersion: r.apiVersion, kind: r.kind, namespace: r.metadata.namespace, name: r.metadata.name, uid: r.metadata.uid });
export const stage = (owner: ResourceRef) => owner.kind === "Route" ? "route" : ["Task", "Routine"].includes(owner.kind) ? "handle" : "assess";
/** Current Topic ownership determines material visibility; assessment/admission is global to the Input. */
export function belongsToTopic(input: Input, owner: ResourceRef, topicUids?: ReadonlySet<string>): boolean {
  return !!input.status.topic && (topicUids ? topicUids.has(input.status.topic.uid) : input.status.topic.uid === owner.uid);
}
export const attemptOf = (input: Input, owner: ResourceRef, topicUids?: ReadonlySet<string>): Attempt | undefined => {
  if (stage(owner) === "route") return input.status.route;
  if (stage(owner) === "handle") return input.status.handle?.[owner.uid!];
  return belongsToTopic(input, owner, topicUids) ? input.status.assess : undefined;
};
type AttemptChange = Partial<Attempt> & { nextAttemptAt?: string; attempts?: number };
export function attemptPatch(input: Input, owner: ResourceRef, change: AttemptChange | ((a?: Attempt) => AttemptChange), topicUids?: ReadonlySet<string>): Partial<InputStatus> {
  const merge = <T extends Attempt>(previous: T): T => Object.fromEntries(Object.entries({ ...previous, ...(typeof change === "function" ? change(previous) : change) }).filter(([, value]) => value !== undefined)) as T;
  if (stage(owner) === "route") return { route: merge(input.status.route ?? {}) };
  if (stage(owner) === "assess") {
    if (!belongsToTopic(input, owner, topicUids)) throw new Error("Input is not assigned to this consumer");
    return { assess: merge(input.status.assess ?? {}) };
  }
  const assigned = input.status.handle?.[owner.uid!];
  if (!assigned) throw new Error("Input is not assigned to this consumer");
  return { handle: { ...input.status.handle, [owner.uid!]: merge(assigned) } };
}
export async function topicScope(resources: ResourceClient, owner: ResourceRef): Promise<TopicResource[]> {
  if (owner.kind !== "Topic") return [];
  return readTopicSubtree(resources, owner);
}
export async function pendingInputs(resources: ResourceClient, owner: ResourceRef, topics?: readonly TopicResource[], index: "assessPending" | "assessReady" = "assessPending") {
  if (owner.kind !== "Topic") return resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: stage(owner) === "route"
    ? { name: "routePending", value: "pending" } : { name: "handlePending", value: owner.uid! } });
  const scope = topics ?? await topicScope(resources, owner);
  const lists = await Promise.all([
    ...scope.map(t => resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: index, value: t.metadata.uid } })),
  ]);
  return [...new Map(lists.flat().map(i => [i.metadata.uid, i])).values()];
}
export async function changeAttempt(resources: ResourceClient, id: string, owner: ResourceRef, change: (p?: Attempt) => Partial<Attempt>) {
  for (let n = 0; ; n++) {
    const input = await resources.get<InputSpec, InputStatus>(inputRef(id));
    if (!input) throw new Error(`Input missing: ${id}`);
    try { return await patchStatus(resources, input, attemptPatch(input, owner, change)); }
    catch (e) { if (n >= 8 || !/version conflict/.test(String(e))) throw e; }
  }
}
/** Input ownership and assessment changes wake the current processing root. */
export function assignmentWatch(key: "assess" | "handle", kind: string, resources?: ResourceClient): Watch {
  const targets = async (input: Input, previous?: Input) => {
    if (key === "handle") return Object.values(input.status.handle ?? {}).filter(s => s.resource.kind === kind
      && (!previous || JSON.stringify(previous.status.handle?.[s.resource.uid]) !== JSON.stringify(s)))
      .map(s => ({ name: s.resource.name, namespace: s.resource.namespace }));
    // Admission bookkeeping, including explicit rejection, must not hot-loop intake. The
    // dispatching Reconcile queues a retry after its active Chief finishes.
    if (previous && !!previous.status.assess === !!input.status.assess
      && previous.status.assess?.completedAt === input.status.assess?.completedAt
      && previous.status.topic?.uid === input.status.topic?.uid) return [];
    const targets = input.status.topic ? [input.status.topic] : [];
    if (!resources) return targets.map(t => ({ name: t.name, namespace: t.namespace }));
    const roots = (await Promise.all(targets.map(t => readTopicRoot(resources, t))))
      .filter((topic): topic is TopicResource => !!topic);
    return [...new Map(roots.map(t => [t.metadata.uid, { name: t.metadata.name, namespace: t.metadata.namespace }])).values()];
  };
  return { resourceType: INPUT_TYPE, handler: { create: async ({ object }) => targets(object as Input),
    update: async ({ oldObject, newObject }) => targets(newObject as Input, oldObject as Input), delete: async () => [] } };
}
/** @spec Deleting Work ends its outstanding handling; Topic deletion requires completed assessment. */
export async function cancelAssignments(resources: ResourceClient, owner: ResourceRef) {
  for (const original of await resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "handlePending", value: owner.uid! } })) {
    for (let n = 0; ; n++) {
      const input = await resources.get<InputSpec, InputStatus>(resourceRef(original));
      const receipt = input?.status.handle?.[owner.uid!];
      if (!input || !receipt || receipt.completedAt) break;
      try {
        await patchStatus(resources, input, { handle: { ...input.status.handle, [owner.uid!]: { ...receipt,
          completedAt: new Date().toISOString(), result: { summary: "Assigned resource deleted", disposition: "cancelled" } } } });
        break;
      } catch (e) { if (n >= 8 || !/version conflict/.test(String(e))) throw e; }
    }
  }
}

/** Update only this admission; a rejected notification cannot clear a completed or replacement claim. */
export async function changeAssessment(resources: ResourceClient, original: Input, executionId: string, change: Partial<Attempt>) {
  for (let n = 0; ; n++) {
    const input = await resources.get<InputSpec, InputStatus>(resourceRef(original));
    if (!input || input.metadata.uid !== original.metadata.uid || input.status.assess?.executionId !== executionId || input.status.assess.completedAt) return;
    const assess = Object.fromEntries(Object.entries({ ...input.status.assess, ...change }).filter(([, v]) => v !== undefined));
    try { await patchStatus(resources, input, { assess }); return; }
    catch (error) { if (n >= 8 || !/version conflict/.test(String(error))) throw error; }
  }
}
