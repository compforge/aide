import type { Resource, ResourceClient, ResourceRef, ResourceType, ResourceListOptions } from "@compforge/aide-plugin";
export interface ResourceDirectory {
  sessions(): readonly string[];
  client(sessionId: string, pluginInstanceId: string): ResourceClient;
}
/** @spec Cross-session writes use the destination client's version guards and Watch dispatcher. */
export function scopedResources(local: ResourceClient, sessionId: string, pluginInstanceId: string, directory?: ResourceDirectory): ResourceClient {
  const owner = (id?: string) => !id || id === sessionId ? local : directory?.client(id, pluginInstanceId) ?? (() => { throw new Error(`Unknown Session: ${id}`); })();
  const stamp = <S, T>(r: Readonly<Resource<S, T>>) => ({ ...r, metadata: { ...r.metadata, sessionId: r.metadata.sessionId ?? sessionId } });
  return {
    ...local,
    async get<S, T>(ref: ResourceRef) { const r = await owner(ref.sessionId).get<S, T>(ref); return r && stamp(r); },
    async list<S, T>(type: ResourceType, options?: ResourceListOptions) {
      if (options?.sessionId === "*") return (await Promise.all((directory?.sessions() ?? [sessionId]).map((id) => owner(id).list<S, T>(type, { ...options, sessionId: id }).then((items) => items.map((r) => ({ ...r, metadata: { ...r.metadata, sessionId: id } })))))).flat();
      return (await owner(options?.sessionId).list<S, T>(type, options)).map(stamp);
    },
    async create(type, init) { return stamp(await owner(init.sessionId).create(type, init)); },
    async replace(r, spec, status) { return stamp(await owner(r.metadata.sessionId).replace(r, spec, status)); },
    async patch(r, patch) { return stamp(await owner(r.metadata.sessionId).patch(r, patch)); },
    async patchStatus(r, patch) { return stamp(await owner(r.metadata.sessionId).patchStatus(r, patch)); },
    async patchMetadata(r, patch) { return stamp(await owner(r.metadata.sessionId).patchMetadata(r, patch)); },
  };
}
