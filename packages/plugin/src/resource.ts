import type {
  AnyResourceNamespace,
  ResourceNamespace,
} from "./namespace.ts";

/** Versioned Resource schema identity, equivalent to a Kubernetes GroupVersionKind. */
export interface ResourceType {
  readonly apiVersion: string;
  readonly kind: string;
  /** Optional compact aliases; they are not part of Resource identity. */
  readonly shortNames?: readonly string[];
}

/**
 * Stable Resource reference.
 *
 * `uid` pins one concrete incarnation. Omit it only when the caller intends
 * name-based lookup that may resolve to a replacement Resource.
 */
export interface ResourceRef extends ResourceType {
  readonly namespace: AnyResourceNamespace;
  readonly name: string;
  readonly uid?: string;
}

/** Pins a dependent Resource to one concrete owner incarnation. */
export interface ResourceOwnerReference extends ResourceRef {
  readonly uid: string;
}

export interface ResourceMetadata {
  /** Stable name within one namespace and Resource type. */
  readonly name: string;
  /** Namespace within the owning plugin instance. */
  readonly namespace: AnyResourceNamespace;
  /** Aide-assigned identity for this concrete incarnation. */
  readonly uid: string;
  /** Desired-state revision. Only spec changes advance it. */
  readonly generation: number;
  /** Opaque optimistic-concurrency token. */
  readonly resourceVersion: string;
  readonly creationTimestamp: string;
  /** Structural owner used by Aide for cascading deletion. */
  readonly owner?: ResourceOwnerReference;
  /** Set after deletion is requested and retained until reconcile succeeds. */
  readonly deletionTimestamp?: string;
  /** Machine-readable grouping and selection metadata owned by the Plugin. */
  readonly labels?: Readonly<Record<string, string>>;
  /** Non-identifying extension metadata owned by the Plugin. */
  readonly annotations?: Readonly<Record<string, string>>;
}

export interface Resource<
  TSpec = Record<string, unknown>,
  TStatus = Record<string, unknown>,
> extends ResourceType {
  readonly metadata: ResourceMetadata;
  readonly spec: TSpec;
  readonly status: TStatus;
}

/**
 * @spec Describe and summarize a supplied snapshot synchronously, without I/O, model calls or mutations.
 * @why Presentation is a Plugin capability; persisted Resources remain serializable facts.
 * @link docs/plugin/README.md
 * @case tests/resource-printer.test.ts
 */
export interface ResourcePrinter<TSpec = unknown, TStatus = unknown> {
  describe(resource: Readonly<Resource<TSpec, TStatus>>): string;
  summarize(resource: Readonly<Resource<TSpec, TStatus>>): string;
}

/** Pure resource-owner rules used by Host storage; absence of a release time protects the record.
 * References are exact Resource UIDs, including references to not-yet-created durable inputs.
 */
export interface ResourceRetention<S = unknown, T = unknown> {
  releasedAt(resource: Readonly<Resource<S, T>>): string | undefined;
  references(resource: Readonly<Resource<S, T>>): readonly string[];
  /** Recheck current dependencies in the eviction transaction; false keeps the candidate protected. */
  canEvict?(resource: Readonly<Resource<S, T>>, context: ResourceValidationContext): boolean;
}

/** A synchronous parser; schema libraries are an implementation choice of the resource owner. */
export interface ResourceSchema<T> { parse(value: unknown): T }

export interface ResourceValidationContext {
  /** Bounded transaction-local query, with the same selectors and cursors as ResourceReader.page. */
  page<S, T>(type: ResourceType, options: ResourcePageOptions): ResourcePage<S, T>;
  /** Transaction-local snapshots in the same resource scope, including preceding writes in a commit. */
  get<S, T>(type: ResourceType, uid: string): Readonly<Resource<S, T>> | undefined;
  list<S, T>(type: ResourceType, options?: Pick<ResourceListOptions, "namespace" | "matchIndex">): readonly Readonly<Resource<S, T>>[];
}
export interface ResourceValidator<S, T> {
  create?(resource: Readonly<Resource<S, T>>, context: ResourceValidationContext): void;
  update?(previous: Readonly<Resource<S, T>>, resource: Readonly<Resource<S, T>>, context: ResourceValidationContext): void;
  delete?(resource: Readonly<Resource<S, T>>, context: ResourceValidationContext): void;
}
/**
 * @spec Definitions load in the Host before resource access and remain independent of Controller/Runner lifetime.
 * @spec Callbacks are synchronous and pure. Validation observes the storage transaction, never a cached Client.
 * @link docs/plugin/README.md
 */
export interface ResourceDefinition<S = any, T = any> {
  readonly type: ResourceType;
  readonly schema: { readonly spec: ResourceSchema<S>; readonly status: ResourceSchema<T> };
  readonly validator?: ResourceValidator<S, T>;
  readonly printer?: ResourcePrinter<S, T>;
  readonly retention?: ResourceRetention<S, T>;
  /** Pure multi-value indexes, maintained atomically with the resource. */
  readonly indexes?: Readonly<Record<string, (resource: Readonly<Resource<S, T>>) => readonly string[]>>;
  /** Exact key plus binary string order; names must differ from equality indexes. */
  readonly orderedIndexes?: Readonly<Record<string, (resource: Readonly<Resource<S, T>>) => readonly { value: string; order: string }[]>>;
}

/** Exact-match label selector. All entries must match the Resource. */
export interface ResourceListOptions {
  /** Exact namespace to query. Plugin-owned Resources default to user-global `v1`. */
  readonly namespace?: AnyResourceNamespace;
  /** Include every descendant namespace below `namespace`. */
  readonly includeDescendants?: boolean;
  readonly matchLabels?: Readonly<Record<string, string>>;
  readonly matchIndex?: { readonly name: string; readonly value: string };
}

/** One bounded page; selectors must remain unchanged while following metadata.continue.
 * @spec Default pages share a collection revision or fail; live traversal returns current objects between stable key bounds.
 * @link docs/plugin/resource.md#分页查询
 */
export interface ResourcePageOptions extends ResourceListOptions {
  /** Required positive integer, at most 1000. */
  readonly limit: number;
  readonly direction?: "asc" | "desc";
  readonly continue?: string;
  /** consistent expires on collection changes; live advances through changing objects up to an initial key bound. */
  readonly consistency?: "consistent" | "live";
}
export interface ResourcePage<S, T> {
  readonly items: readonly Readonly<Resource<S, T>>[];
  readonly metadata: { readonly resourceVersion: string; readonly continue: string };
}
export class ResourceExpired extends Error { override name = "ResourceExpired" }
export class ResourceContinueInvalid extends Error { override name = "ResourceContinueInvalid" }

export interface ResourceReader {
  page<S, T>(type: ResourceType, options: ResourcePageOptions): Promise<ResourcePage<S, T>>;
  get<TSpec, TStatus>(
    ref: ResourceRef,
  ): Promise<Readonly<Resource<TSpec, TStatus>> | undefined>;
  list<TSpec, TStatus>(
    type: ResourceType,
    options?: ResourceListOptions,
  ): Promise<readonly Readonly<Resource<TSpec, TStatus>>[]>;
}

/** Kubernetes-style merge patch payload; each Resource provider validates supported paths. */
export interface ResourceMergePatch {
  readonly type: "merge";
  readonly value: Readonly<Record<string, unknown>>;
}

/** Stable error names also survive the Runner IPC boundary. */
export class ResourceAlreadyExists extends Error { override name = "ResourceAlreadyExists" }
export class ResourceVersionConflict extends Error { override name = "ResourceVersionConflict" }
/** IPC preserves error names, not class identity. */
export const isResourceVersionConflict = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "ResourceVersionConflict";

/** @spec Retry only resource version competition, at most five attempts with short exponential delays.
 * @rule Each attempt must re-read and recompute a pure resource mutation; never replay external effects.
 * @link docs/plugin/resource.md#更新操作与并发
 */
export async function retryOnConflict<T>(change: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await change(); }
    catch (error) {
      if (attempt === 4 || !isResourceVersionConflict(error)) throw error;
      await new Promise(resolve => setTimeout(resolve, 10 * 2 ** attempt));
    }
  }
}
export class ResourceIncarnationChanged extends Error { override name = "ResourceIncarnationChanged" }

/** RFC 6902 operations. Tests and writes run against one transaction-local snapshot. */
export type ResourcePatchOperation =
  | { readonly op: "add" | "replace" | "test"; readonly path: string; readonly value: unknown }
  | { readonly op: "remove"; readonly path: string }
  | { readonly op: "move" | "copy"; readonly path: string; readonly from: string };
export interface ResourceJSONPatch { readonly type: "json"; readonly value: readonly ResourcePatchOperation[] }
export type ResourcePatch = ResourceMergePatch | ResourceJSONPatch;
export interface ResourcePatchOptions {
  /** Opt in to whole-resource optimistic concurrency. UID is always checked. */
  readonly resourceVersion?: string;
}

/** A bounded atomic write set within one Plugin resource scope; external effects are not part of the transaction. */
export type ResourceCommit =
  | { operation: "create"; type: ResourceType; name: string; spec: unknown; status?: unknown }
  /** Requests deletion under the supplied UID/version; normal reconciliation performs final removal. */
  | { operation: "delete"; resource: Resource<unknown, unknown> }
  | { operation: "replace"; resource: Resource<unknown, unknown>; spec: unknown; status: unknown }
  | { operation: "patch"; resource: Resource<unknown, unknown>; patch: ResourcePatch; options?: ResourcePatchOptions }
  | { operation: "patchStatus"; resource: Resource<unknown, unknown>; patch: Record<string, unknown>; options?: ResourcePatchOptions };

export interface ResourceWriter {
  commit(writes: readonly ResourceCommit[]): Promise<readonly Readonly<Resource<unknown, unknown>>[]>;
  create<TSpec, TStatus>(
    type: ResourceType,
    init: {

      name: string;
      /** Concrete Resource namespace. Defaults to the user-global `v1`. */
      namespace?: ResourceNamespace;
      labels?: Readonly<Record<string, string>>;
      annotations?: Readonly<Record<string, string>>;
      owner?: ResourceOwnerReference;
      spec: TSpec;
      status?: TStatus;
    },
  ): Promise<Readonly<Resource<TSpec, TStatus>>>;
  replace<TSpec, TStatus>(resource: Readonly<Resource<TSpec, TStatus>>, spec: TSpec, status: TStatus): Promise<Readonly<Resource<TSpec, TStatus>>>;
  /** Requests cascading deletion; final removal follows successful reconcile. */
  delete(
    type: ResourceType,
    name: string,
    namespace?: ResourceNamespace,
    preconditions?: { readonly uid: string; readonly resourceVersion: string },
  ): Promise<void>;
  /** Applies a patch to the latest Resource incarnation. A snapshot version is not an implicit precondition. */
  patch<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: ResourcePatch,
    options?: ResourcePatchOptions,
  ): Promise<Readonly<Resource<TSpec, TStatus>>>;
  /**
   * Patches Plugin-owned metadata by key. A null value removes that key.
   *
   * Identity, desired state, and observed state remain in their dedicated
   * fields and cannot be changed through this method.
   */
  patchMetadata<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: {
      readonly labels?: Readonly<Record<string, string | null>>;
      readonly annotations?: Readonly<Record<string, string | null>>;
    },
  ): Promise<Readonly<Resource<TSpec, TStatus>>>;
  patchStatus<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: Partial<TStatus>,
    options?: ResourcePatchOptions,
  ): Promise<Readonly<Resource<TSpec, TStatus>>>;
}

/**
 * Host-persisted Resource access, isolated by PluginInstance.
 *
 * @spec Namespace organizes plugin resources independently of execution; omitted mutation namespace defaults to `v1`.
 */
export interface ResourceClient extends ResourceReader, ResourceWriter {
  /**
   * @spec A ResourceRef lookup returns the latest Resource only within the referenced namespace and, when uid is present, only for that exact incarnation; deletion or replacement returns undefined.
   * @rule After awaiting a Core verb, use a uid-pinned ref before applying the result so a stale continuation cannot write to a replacement Resource.
   */
  get<TSpec, TStatus>(
    ref: ResourceRef,
  ): Promise<Readonly<Resource<TSpec, TStatus>> | undefined>;
}
