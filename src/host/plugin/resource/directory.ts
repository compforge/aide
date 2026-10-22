import type { Resource, ResourceClient, ResourceRef, ResourceType, ResourceListOptions } from "@compforge/aide-plugin";
export interface ResourceDirectory {
  sessions(): readonly string[];
  client(sessionId: string, pluginInstanceId: string): ResourceClient;
  shared?(pluginInstanceId: string): ResourceClient;
  ensureSession?(sessionId: string): Promise<void>;
}
/** @spec Cross-session writes use the destination client's version guards and Watch dispatcher. */
export function scopedResources(local: ResourceClient, sessionId: string, pluginInstanceId: string, directory?: ResourceDirectory,
  isShared: (type: ResourceType) => boolean = () => false, shared?: ResourceClient): ResourceClient {
  const owner = (type: ResourceType, id?: string) => {
    if (isShared(type)) {
      if (id && id !== "*") throw new Error(`Shared resource ${type.kind} cannot select a Session`);
      return shared ?? directory?.shared?.(pluginInstanceId) ?? local;
    }
    return !id || id === sessionId ? local : directory?.client(id, pluginInstanceId) ?? (() => { throw new Error(`Unknown Session: ${id}`); })();
  };
  const stamp = <S, T>(r: Readonly<Resource<S, T>>) => isShared(r) ? r : ({ ...r, metadata: { ...r.metadata, sessionId: r.metadata.sessionId ?? sessionId } });
  return {
    ...local,
    async commit(writes) {
      const clients = new Set(writes.map((w) => w.operation === "create" ? owner(w.type) : owner(w.resource, w.resource.metadata.sessionId)));
      if (clients.size > 1) throw new Error("Resource commit cannot cross resource scopes");
      return (await ([...clients][0] ?? local).commit(writes)).map(stamp);
    },
    async get<S, T>(ref: ResourceRef) { const r = await owner(ref, ref.sessionId).get<S, T>(ref); return r && stamp(r); },
    async list<S, T>(type: ResourceType, options?: ResourceListOptions) {
      if (options?.sessionId === "*" && !isShared(type)) return (await Promise.all((directory?.sessions() ?? [sessionId]).map((id) => owner(type, id).list<S, T>(type, { ...options, sessionId: id }).then((items) => items.map((r) => ({ ...r, metadata: { ...r.metadata, sessionId: id } })))))).flat();
      return (await owner(type, options?.sessionId).list<S, T>(type, options)).map(stamp);
    },
    async create(type, init) {
      // Reads remain side-effect free; only an explicit create can provision a destination.
      if (!isShared(type) && init.sessionId && init.sessionId !== sessionId) await directory?.ensureSession?.(init.sessionId);
      return stamp(await owner(type, init.sessionId).create(type, init));
    },
    async delete(type, name, namespace) { return owner(type).delete(type, name, namespace); },
    async replace(r, spec, status) { return stamp(await owner(r, r.metadata.sessionId).replace(r, spec, status)); },
    async patch(r, patch) { return stamp(await owner(r, r.metadata.sessionId).patch(r, patch)); },
    async patchStatus(r, patch) { return stamp(await owner(r, r.metadata.sessionId).patchStatus(r, patch)); },
    async patchMetadata(r, patch) { return stamp(await owner(r, r.metadata.sessionId).patchMetadata(r, patch)); },
  };
}
