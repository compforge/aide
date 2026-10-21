import type { TurnSummary } from "./snapshot.ts";
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
  readonly sessionId?: string;
  readonly namespace: AnyResourceNamespace;
  readonly name: string;
  readonly uid?: string;
}

/** Pins a dependent Resource to one concrete owner incarnation. */
export interface ResourceOwnerReference extends ResourceRef {
  readonly uid: string;
}

export interface ResourceMetadata {
  readonly sessionId?: string;
  /** Stable name within one namespace and Resource type. */
  readonly name: string;
  /** Concrete Resource scope. Aide-owned Resources use a Aide-reserved namespace. */
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
  readonly resourceType: ResourceType;
  describe(resource: Readonly<Resource<TSpec, TStatus>>): string;
  summarize(resource: Readonly<Resource<TSpec, TStatus>>): string;
}

/** Pure resource-owner rules used by Host storage; absence of a release time protects the record.
 * References are exact Resource UIDs, including references to not-yet-created durable inputs.
 */
export interface ResourceLifecycle {
  readonly resourceType: ResourceType;
  releasedAt(resource: Readonly<Resource<unknown, unknown>>): string | undefined;
  references(resource: Readonly<Resource<unknown, unknown>>): readonly string[];
}

/** Exact-match label selector. All entries must match the Resource. */
export interface ResourceListOptions {
  /** Explicit Session selection; "*" lists active host Sessions. Omitted means current Session. */
  readonly sessionId?: string;
  /** Exact namespace to query. Plugin-owned Resources default to user-global `v1`. */
  readonly namespace?: AnyResourceNamespace;
  /** Include every descendant namespace below `namespace`. */
  readonly includeDescendants?: boolean;
  readonly matchLabels?: Readonly<Record<string, string>>;
}

export interface ResourceReader {
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

/** A bounded atomic write set in one Session and Plugin scope. Core creates are limited to Output. */
export type ResourceCommit =
  | { operation: "create"; type: ResourceType; name: string; spec: unknown; status?: unknown }
  | { operation: "replace"; resource: Resource<unknown, unknown>; spec: unknown; status: unknown }
  | { operation: "patchStatus"; resource: Resource<unknown, unknown>; patch: Record<string, unknown> };

export interface ResourceWriter {
  commit(writes: readonly ResourceCommit[]): Promise<readonly Readonly<Resource<unknown, unknown>>[]>;
  create<TSpec, TStatus>(
    type: ResourceType,
    init: {
      sessionId?: string;
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
  ): Promise<void>;
  /** Applies one optimistic patch against the supplied Resource incarnation/version. */
  patch<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: ResourceMergePatch,
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
  ): Promise<Readonly<Resource<TSpec, TStatus>>>;
}

/**
 * Host-owned Resource access. Core projections are provider-backed, while
 * Plugin-owned Resources remain isolated by PluginInstance.
 *
 * @spec One PluginInstance may own Resources in global, Project, and Session namespaces simultaneously; omitted mutation namespace defaults to `v1`.
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

export type AideTurnResourceApiVersion = "aide.dev/v1alpha1";
export type AideTurnResourceKind = "Turn";

export type AideSessionResourceKind = "Session";
export type AideTargetResourceKind = "Target";
export type AideSessionTargetBindingResourceKind = "SessionTargetBinding";

export interface AideSessionResourceStatus {
  readonly phase: "Active" | "Inactive";
}

export interface AideTargetResourceSpec {
  readonly harness: string;
}

export interface AideTargetResourceStatus {
  readonly phase: "Ready" | "Unavailable";
  /** list returns the last observation; get refreshes missing/expired discovery without opening a HarnessSession. */
  readonly modelCatalog?: AideTargetModelCatalog;
}

export interface AideTargetModel {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly efforts: readonly { readonly id: string; readonly label: string }[];
}

/** Discovery state is independent of whether a Target is configured/eligible for routing. */
export type AideTargetModelCatalog =
  | { readonly phase: "Pending" }
  | { readonly phase: "Unavailable"; readonly observedAt: string }
  | { readonly phase: "Failed"; readonly observedAt: string; readonly message: string }
  | { readonly phase: "Ready"; readonly observedAt: string; readonly models: readonly AideTargetModel[] };

export interface AideSessionTargetBindingResourceSpec {
  readonly sessionRef: ResourceRef;
  readonly eligibleTargetRefs: readonly ResourceRef[];
  readonly targetRef?: ResourceRef;
}

export interface AideSessionTargetBindingResourceStatus {
  readonly observedGeneration: number;
  readonly effectiveTargetRef?: ResourceRef;
  readonly phase: "Pending" | "Bound" | "Failed";
}

export type AideTurnResourceData = TurnSummary & {
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly laneId?: string;
  readonly harnessSessionId?: string;
};

/** Read-only Resource shape exposed by Aide-owned Turn observations. */
export type AideTurnResource = Resource<
  Record<string, never>,
  AideTurnResourceData
> & {
  readonly apiVersion: AideTurnResourceApiVersion;
  readonly kind: AideTurnResourceKind;
};

export type AideSessionResource = Resource<
  Record<string, never>,
  AideSessionResourceStatus
> & {
  readonly apiVersion: AideTurnResourceApiVersion;
  readonly kind: AideSessionResourceKind;
};

export type AideTargetResource = Resource<
  AideTargetResourceSpec,
  AideTargetResourceStatus
> & {
  readonly apiVersion: AideTurnResourceApiVersion;
  readonly kind: AideTargetResourceKind;
};

export type AideSessionTargetBindingResource = Resource<
  AideSessionTargetBindingResourceSpec,
  AideSessionTargetBindingResourceStatus
> & {
  readonly apiVersion: AideTurnResourceApiVersion;
  readonly kind: AideSessionTargetBindingResourceKind;
};
