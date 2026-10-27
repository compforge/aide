import type { Resource, ResourceClient, ResourceRef, Watch } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus, type Attempt, type Assessment } from "./model.ts";
import type { TopicResource } from "../topic/model.ts";
import { readTopicSubtree, readTopicRoot } from "../topic/tree.ts";
export type Input = Readonly<Resource<InputSpec, InputStatus>>;
export const inputRef = (name: string) => ({ ...INPUT_TYPE, namespace: "v1" as const, name });
export const resourceRef = (r: Readonly<Resource<unknown, unknown>>) => ({ apiVersion: r.apiVersion, kind: r.kind, namespace: r.metadata.namespace, name: r.metadata.name, uid: r.metadata.uid });
export const stage = (owner: ResourceRef) => owner.kind === "Route" ? "route" : ["Task", "Routine"].includes(owner.kind) ? "handle" : "assess";
/** Assessment belongs to the fixed Topic, independently of the Chief viewing its material. */
export function assessments(input: Input, owner: ResourceRef, topicUids?: ReadonlySet<string>): [string, Assessment][] {
  return Object.entries(input.status.assess ?? {}).filter(([uid]) => topicUids ? topicUids.has(uid) : uid === owner.uid);
}
export const attemptOf = (input: Input, owner: ResourceRef, topicUids?: ReadonlySet<string>): Attempt | undefined => {
  if (stage(owner) === "route") return input.status.route;
  if (stage(owner) === "handle") return input.status.handle?.[owner.uid!];
  const receipts = assessments(input, owner, topicUids).map(([, a]) => a);
  return receipts.find(a => !a.completedAt) ?? receipts[0];
};
type AttemptChange = Partial<Attempt> & { nextAttemptAt?: string; attempts?: number };
export function attemptPatch(input: Input, owner: ResourceRef, change: AttemptChange | ((a?: Attempt) => AttemptChange), topicUids?: ReadonlySet<string>): Partial<InputStatus> {
  const merge = <T extends Attempt>(previous: T): T => Object.fromEntries(Object.entries({ ...previous, ...(typeof change === "function" ? change(previous) : change) }).filter(([, value]) => value !== undefined)) as T;
  if (stage(owner) === "route") return { route: merge(input.status.route ?? {}) };
  if (stage(owner) === "assess") {
    const selected = assessments(input, owner, topicUids);
    if (!selected.length) throw new Error("Input is not assigned to this consumer");
    return { assess: { ...input.status.assess, ...Object.fromEntries(selected.map(([uid, a]) => [uid, merge(a)])) } };
  }
  const assigned = input.status.handle?.[owner.uid!];
  if (!assigned) throw new Error("Input is not assigned to this consumer");
  return { handle: { ...input.status.handle, [owner.uid!]: merge(assigned) } };
}
export async function topicScope(resources: ResourceClient, owner: ResourceRef): Promise<TopicResource[]> {
  if (owner.kind !== "Topic") return [];
  return readTopicSubtree(resources, owner);
}
export async function pendingInputs(resources: ResourceClient, owner: ResourceRef, topics?: readonly TopicResource[]) {
  if (owner.kind !== "Topic") return resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: stage(owner) === "route"
    ? { name: "routePending", value: "pending" } : { name: "handlePending", value: owner.uid! } });
  const scope = topics ?? await topicScope(resources, owner);
  const lists = await Promise.all([
    ...scope.map(t => resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "assessPending", value: t.metadata.uid } })),
  ]);
  return [...new Map(lists.flat().map(i => [i.metadata.uid, i])).values()];
}
export async function changeAttempt(resources: ResourceClient, id: string, owner: ResourceRef, change: (p?: Attempt) => Partial<Attempt>) {
  for (let n = 0; ; n++) {
    const input = await resources.get<InputSpec, InputStatus>(inputRef(id));
    if (!input) throw new Error(`Input missing: ${id}`);
    try { return await resources.patchStatus(input, attemptPatch(input, owner, change)); }
    catch (e) { if (n >= 8 || !/version conflict/.test(String(e))) throw e; }
  }
}
/** Input changes wake their current processing roots, while durable assignments stay on their source Topics. */
export function assignmentWatch(key: "assess" | "handle", kind: string, resources?: ResourceClient): Watch {
  const targets = async (input: Input, previous?: Input) => {
    const changed = Object.values(input.status[key] ?? {}).filter(s => s.resource.kind === kind
      && (!previous || JSON.stringify(previous.status[key]?.[s.resource.uid]) !== JSON.stringify(s)));
    if (key !== "assess" || !resources) return changed.map(s => ({ name: s.resource.name, namespace: s.resource.namespace }));
    const roots = (await Promise.all(changed.map(s => readTopicRoot(resources, s.resource))))
      .filter((topic): topic is TopicResource => !!topic);
    return [...new Map(roots.map(t => [t.metadata.uid, { name: t.metadata.name, namespace: t.metadata.namespace }])).values()];
  };
  return { resourceType: INPUT_TYPE, handler: { create: async ({ object }) => targets(object as Input),
    update: async ({ oldObject, newObject }) => targets(newObject as Input, oldObject as Input), delete: async () => [] } };
}
/** @spec Deleting a consumer ends its outstanding assignments; the fact can then become collectible. */
export async function cancelAssignments(resources: ResourceClient, owner: ResourceRef, key: "assess" | "handle") {
  for (const original of await resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: `${key}Pending`, value: owner.uid! } })) {
    for (let n = 0; ; n++) {
      const input = await resources.get<InputSpec, InputStatus>(inputRef(original.metadata.name));
      const receipt = input?.status[key]?.[owner.uid!];
      if (!input || !receipt || receipt.completedAt) break;
      try {
        await resources.patchStatus(input, { [key]: { ...input.status[key], [owner.uid!]: { ...receipt, completedAt: new Date().toISOString(),
          result: { summary: "Assigned resource deleted", disposition: "cancelled" } } } }); break;
      } catch (e) { if (n >= 8 || !/version conflict/.test(String(e))) throw e; }
    }
  }
}
