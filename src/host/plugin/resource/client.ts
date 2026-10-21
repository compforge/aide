import type {
  Resource,
  ResourceCommit,
  ResourceClient as PublicResourceClient,
  ResourceListOptions,
  ResourceMergePatch,
  ResourceOwnerReference,
  ResourceRef,
  ResourceNamespace,
  ResourceType,
} from "@compforge/aide-plugin";

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

export interface AideResourceAccess {
  create?<S, T>(type: ResourceType, name: string, spec: S): Readonly<Resource<S, T>>;
  patchStatus?<S, T>(resource: Readonly<Resource<S, T>>, patch: Partial<T>): Readonly<Resource<S, T>>;
  handles(type: ResourceType): boolean;
  get<TSpec, TStatus>(
    ref: ResourceRef,
  ): Readonly<Resource<TSpec, TStatus>> | undefined | Promise<Readonly<Resource<TSpec, TStatus>> | undefined>;
  list<TSpec, TStatus>(
    type: ResourceType,
    options?: ResourceListOptions,
  ): readonly Readonly<Resource<TSpec, TStatus>>[];
  patch<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: ResourceMergePatch,
  ): Readonly<Resource<TSpec, TStatus>>;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Routes Core projections and isolates Plugin-owned state by PluginInstance. */
export function createResourceClient(
  store: PluginResourceStore,
  onChange?: (change: ResourceClientChange) => void,
  assertCanCreateType?: (type: ResourceType) => void,
  aideResources?: AideResourceAccess,
): ResourceClient {
  const assertSession = (id?: string) => {
    if (id && id !== store.aideSessionId) throw new Error(`Resource scope does not belong to Session ${id}`);
  };
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
  const assertOwned = (
    resource: Readonly<Resource<unknown, unknown>>,
  ): void => {
    assertSession(resource.metadata.sessionId);
    if (resource.metadata.namespace === "aide-system") {
      throw new Error(
        `plugin ResourceClient cannot mutate Aide-owned ${resource.kind}/${resource.metadata.name}`,
      );
    }
  };

  async function get<TSpec, TStatus>(
    ref: ResourceRef,
  ): Promise<Readonly<Resource<TSpec, TStatus>> | undefined> {
    if (aideResources?.handles(ref)) {
      return aideResources.get<TSpec, TStatus>(ref);
    }
    assertSession(ref.sessionId);
    if (ref.namespace === "aide-system") {
      throw new Error(
        `plugin ResourceClient cannot access Aide-owned ${ref.kind}/${ref.name}`,
      );
    }
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
      sessionId?: string;
      name: string;
      namespace?: ResourceNamespace;
      labels?: Readonly<Record<string, string>>;
      annotations?: Readonly<Record<string, string>>;
      owner?: ResourceOwnerReference;
      spec: TSpec;
      status?: TStatus;
    }
  ) {
    if (aideResources?.handles(type)) {
      if (!aideResources.create) throw new Error(`Cannot create builtin ${type.kind}`);
      return aideResources.create<TSpec, TStatus>(type, init.name, init.spec);
    }
    assertCanCreateType?.(type);
    assertSession(init.sessionId);
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
    changed("created", created);
    return created;
  }
  function replace<TSpec, TStatus>(resource: Readonly<Resource<TSpec, TStatus>>, spec: TSpec, status: TStatus) {
    assertOwned(resource);
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
    if (aideResources?.handles(resource)) {
      if (!aideResources.patchStatus) throw new Error(`Cannot update builtin ${resource.kind}`);
      return aideResources.patchStatus(resource, patch);
    }
    assertOwned(resource);
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
  async function commit(writes: readonly ResourceCommit[]) {
    if (!writes.length || writes.length > 100) throw new Error("Resource commit requires 1..100 writes");
    // Core projections backed by external state cannot participate in this SQLite transaction.
    for (const w of writes) {
      const type = w.operation === "create" ? w.type : w.resource;
      if (aideResources?.handles(type) && !(w.operation === "create" && type.apiVersion === "aide.dev/v1alpha1" && type.kind === "Output")) {
        throw new Error("Atomic Core writes support only Output creation");
      }
      if (w.operation !== "create" && w.resource.metadata.sessionId && w.resource.metadata.sessionId !== store.aideSessionId) throw new Error("Resource commit cannot cross Sessions");
    }
    return store.storage.transaction(() => writes.map((w) => w.operation === "create"
      ? create(w.type, { name: w.name, spec: w.spec, status: w.status })
      : w.operation === "replace" ? replace(w.resource, w.spec, w.status) : patchStatus(w.resource, w.patch))) as Resource<unknown, unknown>[];
  }

  return Object.freeze({
    get,
    commit,
    async list<TSpec, TStatus>(
      type: ResourceType,
      options?: ResourceListOptions,
    ) {
      if (aideResources?.handles(type)) {
        return aideResources.list<TSpec, TStatus>(type, options);
      }
      if (options?.sessionId !== "*") assertSession(options?.sessionId);
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
    ) {
      const resource = deepFreeze(store.get(type, name, namespace));
      assertOwned(resource);
      for (const update of store.requestDeletion(
        type,
        name,
        undefined,
        namespace,
      )) {
        try {
          onChange?.(Object.freeze({
            pluginInstanceId: store.pluginInstanceId,
            kind: "deletion-requested",
            oldResource: deepFreeze(update.oldResource),
            resource: deepFreeze(update.resource),
          }));
        } catch {
          // Deletion is durable; host reactions must not turn it into failure.
        }
      }
    },
    async patch<TSpec, TStatus>(
      resource: Readonly<Resource<TSpec, TStatus>>,
      patch: ResourceMergePatch,
    ) {
      if (aideResources?.handles(resource)) {
        return aideResources.patch(resource, patch);
      }
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
      assertOwned(resource);
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
