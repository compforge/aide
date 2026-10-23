import type { Resource, ResourceClient, ResourceRef, Watch } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus, type Attempt } from "./model.ts";
export type Input = Readonly<Resource<InputSpec, InputStatus>>;
export const inputRef = (name: string) => ({ ...INPUT_TYPE, namespace: "v1" as const, name });
export const resourceRef = (r: Readonly<Resource<unknown, unknown>>) => ({ apiVersion: r.apiVersion, kind: r.kind, namespace: r.metadata.namespace, name: r.metadata.name, uid: r.metadata.uid });
export const stage = (owner: ResourceRef) => owner.kind === "Route" ? "route" : ["Task", "Routine"].includes(owner.kind) ? "handle" : "assess";
export const attemptOf = (input: Input, owner: ResourceRef): Attempt | undefined => stage(owner) === "route" ? input.status.route : input.status[stage(owner) as "assess" | "handle"]?.[owner.uid!];
export function attemptPatch(input: Input, owner: ResourceRef, change: Partial<Attempt> & { nextAttemptAt?: string; attempts?: number }): Partial<InputStatus> {
  const merge = <T extends Attempt>(previous: T): T => Object.fromEntries(Object.entries({ ...previous, ...change }).filter(([, value]) => value !== undefined)) as T;
  if (stage(owner) === "route") return { route: merge(input.status.route ?? {}) };
  const assigned = input.status[stage(owner) as "assess" | "handle"]?.[owner.uid!];
  if (!assigned) throw new Error("Input is not assigned to this consumer");
  return { [stage(owner)]: { ...input.status[stage(owner) as "assess" | "handle"], [owner.uid!]: merge(assigned) } };
}
export async function pendingInputs(resources: ResourceClient, owner: ResourceRef) {
  return resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: stage(owner) === "route"
    ? { name: "routePending", value: "pending" } : { name: `${stage(owner)}Pending`, value: owner.uid! } });
}
export async function changeAttempt(resources: ResourceClient, id: string, owner: ResourceRef, change: (p?: Attempt) => Partial<Attempt>) {
  for (let n = 0; ; n++) {
    const input = await resources.get<InputSpec, InputStatus>(inputRef(id));
    if (!input) throw new Error(`Input missing: ${id}`);
    try { return await resources.patchStatus(input, attemptPatch(input, owner, change(attemptOf(input, owner)))); }
    catch (e) { if (n >= 8 || !/version conflict/.test(String(e))) throw e; }
  }
}
/** @spec Input status is the inbox. Only changed assignments wake their resource, never unrelated consumers. */
export function assignmentWatch(key: "assess" | "handle", kind: string): Watch {
  const targets = (input: Input, previous?: Input) => Object.values(input.status[key] ?? {}).filter(s => s.resource.kind === kind
    && (!previous || JSON.stringify(previous.status[key]?.[s.resource.uid]) !== JSON.stringify(s)))
    .map(s => ({ name: s.resource.name, namespace: s.resource.namespace }));
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
