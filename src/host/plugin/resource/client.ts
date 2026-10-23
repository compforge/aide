import type { Resource, ResourceCommit, ResourceClient as PublicResourceClient, ResourceListOptions, ResourceMergePatch, ResourceOwnerReference, ResourceRef, ResourceNamespace, ResourceType } from "@compforge/aide-plugin";

import { PluginResourceStore } from "./store.ts";

export type ResourceClient = PublicResourceClient;

export type ResourceClientChange = {
  readonly pluginInstanceId: string;
} & (
  | {
      readonly kind: "created";
      readonly resource: Readonly<Resource<unknown, unknown>>;
    }
  | {
      readonly kind: "status-updated";
      readonly oldResource: Readonly<Resource<unknown, unknown>>;
      readonly resource: Readonly<Resource<unknown, unknown>>;
    }
  | {
      readonly kind: "metadata-updated";
      readonly oldResource: Readonly<Resource<unknown, unknown>>;
      readonly resource: Readonly<Resource<unknown, unknown>>;
    }
  | {
      readonly kind: "deletion-requested";
      readonly oldResource: Readonly<Resource<unknown, unknown>>;
      readonly resource: Readonly<Resource<unknown, unknown>>;
    }
  | {
      readonly kind: "deleted";
      readonly resource: Readonly<Resource<unknown, unknown>>;
    }
);

/** Optional plugin admission for immutable facts and idempotency receipts, in the same storage transaction. */
export type ResourceAdmission = (type: ResourceType, init: { name: string; spec: unknown; status?: unknown; namespace?: ResourceNamespace }, writes: {
  create(type: ResourceType, init: { name: string; spec: unknown; status?: unknown; namespace?: ResourceNamespace }): Resource<unknown, unknown>;
  patchStatus<S, T>(resource: Readonly<Resource<S, T>>, patch: Partial<T>): Readonly<Resource<S, T>>;
}) => Resource<unknown, unknown> | undefined;

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Isolates Plugin-owned state by PluginInstance. */
export function createResourceClient(
  store: PluginResourceStore,
  onChange?: (change: ResourceClientChange) => void,
  assertCanCreateType?: (type: ResourceType) => void,
  admit?: ResourceAdmission,
): ResourceClient {
  const changed = (
    kind: "created" | "status-updated" | "metadata-updated" | "deleted",
    resource: Readonly<Resource<unknown, unknown>>,
    oldResource?: Readonly<Resource<unknown, unknown>>,
  ): void => {
    store.storage.afterCommit(() => { try {
      onChange?.(
        kind === "status-updated" || kind === "metadata-updated"
          ? Object.freeze({
              pluginInstanceId: store.pluginInstanceId,
              kind,
              oldResource: oldResource!,
              resource,
            })
          : Object.freeze({
              pluginInstanceId: store.pluginInstanceId,
              kind,
              resource,
            }),
      );
    } catch {
      // Resource mutation has committed; host reactions must not turn it into failure.
    } });
  };
  async function get<TSpec, TStatus>(
    ref: ResourceRef,
  ): Promise<Readonly<Resource<TSpec, TStatus>> | undefined> {
    const current = store.find<TSpec, TStatus>(
      ref,
      ref.name,
      ref.namespace,
    );
    if (
      !current ||
      (ref.uid !== undefined && current.metadata.uid !== ref.uid)
    ) {
      return undefined;
    }
    return deepFreeze(current);
  }

  function create<TSpec, TStatus>(
    type: ResourceType,
    init: {
      name: string;
      namespace?: ResourceNamespace;
      labels?: Readonly<Record<string, string>>;
      annotations?: Readonly<Record<string, string>>;
      owner?: ResourceOwnerReference;
      spec: TSpec;
      status?: TStatus;
    }
  ) {
    assertCanCreateType?.(type);
    return store.storage.transaction(() => {
      const admitted = admit?.(type, init, { create: (type, init) => createStored(type, init, false), patchStatus });
      if (admitted) { changed("created", admitted); return deepFreeze(admitted) as Resource<TSpec, TStatus>; }
      return createStored(type, init);
    });
  }
  function createStored<TSpec, TStatus>(type: ResourceType, init: {
    name: string; namespace?: ResourceNamespace; labels?: Readonly<Record<string, string>>;
    annotations?: Readonly<Record<string, string>>; owner?: ResourceOwnerReference; spec: TSpec; status?: TStatus;
  }, notify = true) {
    const created = deepFreeze(
      store.create<TSpec, TStatus>({
        type,
        name: init.name,
        ...(init.namespace === undefined
          ? {}
          : { namespace: init.namespace }),
        ...(init.labels === undefined ? {} : { labels: init.labels }),
        ...(init.annotations === undefined
          ? {}
          : { annotations: init.annotations }),
        ...(init.owner === undefined ? {} : { owner: init.owner }),
        spec: init.spec,
        status: init.status,
      }),
    );
    if (notify) changed("created", created);
    return created;
  }
  function replace<TSpec, TStatus>(resource: Readonly<Resource<TSpec, TStatus>>, spec: TSpec, status: TStatus) {
    if (store.get(resource, resource.metadata.name, resource.metadata.namespace as ResourceNamespace).metadata.uid !== resource.metadata.uid) throw new Error("Resource incarnation changed before replacement");
    const updated = deepFreeze(store.replace(resource, resource.metadata.name, spec, status, {
      expectedResourceVersion: resource.metadata.resourceVersion, namespace: resource.metadata.namespace as ResourceNamespace,
    }));
    if (updated.metadata.resourceVersion !== resource.metadata.resourceVersion) changed("status-updated", updated, resource);
    return updated;
  }
  function patchStatus<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: Partial<TStatus>,
  ) {
    if (store.get(resource, resource.metadata.name, resource.metadata.namespace as ResourceNamespace).metadata.uid !== resource.metadata.uid) throw new Error("Resource incarnation changed before status update");
    const patched = deepFreeze(
      store.patchStatus<TSpec, TStatus>(
        resource,
        resource.metadata.name,
        patch,
        {
          expectedResourceVersion: resource.metadata.resourceVersion,
          namespace: resource.metadata.namespace as ResourceNamespace,
        },
      ),
    );
    if (
      patched.metadata.resourceVersion !==
      resource.metadata.resourceVersion
    ) {
      changed("status-updated", patched, resource);
    }
    return patched;
  }
  function requestDeletion(type: ResourceType, name: string, namespace: ResourceNamespace = "v1", preconditions?: { uid: string; resourceVersion: string }) {
    const updates = store.requestDeletion(type, name, undefined, namespace, preconditions);
    const resource = deepFreeze(store.get(type, name, namespace));
    for (const update of updates) store.storage.afterCommit(() => {
      try {
        onChange?.(Object.freeze({ pluginInstanceId: store.pluginInstanceId, kind: "deletion-requested",
          oldResource: deepFreeze(update.oldResource), resource: deepFreeze(update.resource) }));
      } catch {
        // Deletion is durable; host reactions must not turn it into failure.
      }
    });
    return resource;
  }
  async function commit(writes: readonly ResourceCommit[]) {
    if (!writes.length || writes.length > 100) throw new Error("Resource commit requires 1..100 writes");
    // All writes use the same storage transaction and publish Watch events only after commit.
    return store.storage.transaction(() => writes.map((w) => w.operation === "create"
      ? create(w.type, { name: w.name, spec: w.spec, status: w.status })
      : w.operation === "delete" ? requestDeletion(w.resource, w.resource.metadata.name, w.resource.metadata.namespace as ResourceNamespace,
        { uid: w.resource.metadata.uid, resourceVersion: w.resource.metadata.resourceVersion })
      : w.operation === "replace" ? replace(w.resource, w.spec, w.status) : patchStatus(w.resource, w.patch))) as Resource<unknown, unknown>[];
  }

  return Object.freeze({
    get,
    commit,
    async list<TSpec, TStatus>(
      type: ResourceType,
      options?: ResourceListOptions,
    ) {
      return store
        .list<TSpec, TStatus>(type, options)
        .map((resource) => deepFreeze(resource));
    },
    create: async <S, T>(type: ResourceType, init: Parameters<typeof create<S, T>>[1]) => create<S, T>(type, init),
    replace: async <S, T>(resource: Readonly<Resource<S, T>>, spec: S, status: T) => replace(resource, spec, status),
    async delete(
      type: ResourceType,
      name: string,
      namespace: ResourceNamespace = "v1",
      preconditions?: { uid: string; resourceVersion: string },
    ) {
      requestDeletion(type, name, namespace, preconditions);
    },
    async patch<TSpec, TStatus>(
      resource: Readonly<Resource<TSpec, TStatus>>,
      patch: ResourceMergePatch,
    ) {
      throw new Error(
        `Resource ${resource.apiVersion}/${resource.kind} does not support generic patch`,
      );
    },
    async patchMetadata<TSpec, TStatus>(
      resource: Readonly<Resource<TSpec, TStatus>>,
      patch: {
        readonly labels?: Readonly<Record<string, string | null>>;
        readonly annotations?: Readonly<Record<string, string | null>>;
      },
    ) {
      const patched = deepFreeze(
        store.patchMetadata<TSpec, TStatus>(
          resource,
          resource.metadata.name,
          patch,
          {
            expectedResourceVersion: resource.metadata.resourceVersion,
            namespace: resource.metadata.namespace as ResourceNamespace,
          },
        ),
      );
      if (
        patched.metadata.resourceVersion !==
        resource.metadata.resourceVersion
      ) {
        changed("metadata-updated", patched, resource);
      }
      return patched;
    },
    patchStatus: async <S, T>(resource: Readonly<Resource<S, T>>, patch: Partial<T>) => patchStatus(resource, patch),
  });
}
