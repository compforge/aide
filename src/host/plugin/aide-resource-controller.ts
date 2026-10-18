import type {
  AnyEventEnvelope,
  EventEnvelope,
  TurnSummary,
} from "../event/index.ts";
import type {
  ReconcileContext,
  ResourceRef,
  ResourceNamespace,
  Watch,
} from "@compforge/aide-plugin";
import type { SessionHandle } from "../store/store.ts";
import { newId } from "../event/ids.ts";
import {
  type ControllerRetryOptions,
  type ReconcileKey,
  type ReconcileResult,
  ReconcileRetry,
  type ReconcileScope,
  type ScheduledReconcile,
} from "./controller.ts";
import type { ResourceClientChange } from "./resource-client.ts";
import { ReconcileQueue, type ReconcileCapacityLease } from "./queue.ts";
import { reconcileResourceOwner } from "./reconcile-scope.ts";
import {
  emptyReconcileSnapshot,
  type ReconcileSnapshot,
} from "./reconcile-snapshot.ts";
import { validateSources } from "./source.ts";
import { validateWatches, watchRequests } from "./watch.ts";
import {
  createReconcileContext,
} from "../../plugin-context.ts";
import {
  type ExecutionScope,
  type InvokeVerb,
} from "../../protocol/verbs.ts";
import type {
  ControllerSource,
  CronSource,
} from "./package.ts";
import {
  AIDE_SYSTEM_NAMESPACE,
  AIDE_TURN_RESOURCE_TYPE,
} from "./package.ts";

export const AIDE_TURN_RESOURCE_KIND = AIDE_TURN_RESOURCE_TYPE.kind;

export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export type AideTurnResourceData = DeepReadonly<TurnSummary> & {
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly laneId?: string;
  readonly harnessSessionId?: string;
};

export interface AideResourceDataMap {
  [AIDE_TURN_RESOURCE_KIND]: AideTurnResourceData;
}

export type AideResourceKind = keyof AideResourceDataMap;

export interface AideResourceObservationMetadata {
  readonly aideSessionId: string;
  readonly resourceId: string;
  /** 产生当前 Resource 的 ledger seq；Aide-owned Resource 自身不另设持久真相。 */
  readonly revision: number;
  readonly sourceEventId: string;
  readonly observedAt: string;
}

export interface AideResourceObservation<K extends AideResourceKind = AideResourceKind> {
  readonly kind: K;
  readonly metadata: AideResourceObservationMetadata;
  readonly data: AideResourceDataMap[K];
}

export type AnyAideResourceObservation = {
  [K in AideResourceKind]: AideResourceObservation<K>;
}[AideResourceKind];

type AideResourceSession = Pick<
  SessionHandle,
  "id" | "dir" | "ledger" | "subscribe"
>;

export interface AideResourceIndexOptions {
  session: AideResourceSession;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function turnResource(
  event: EventEnvelope<"_aide_turn_summary">,
): AideResourceObservation<typeof AIDE_TURN_RESOURCE_KIND> {
  return deepFreeze({
    kind: AIDE_TURN_RESOURCE_KIND,
    metadata: {
      aideSessionId: event.scope.aideSessionId,
      resourceId: event.payload.turnId,
      revision: event.seq,
      sourceEventId: event.eventId,
      observedAt: event.ts,
    },
    data: {
      ...event.payload,
      ...(event.harness === undefined ? {} : { harness: event.harness }),
      ...(event.harnessTargetId === undefined
        ? {}
        : { harnessTargetId: event.harnessTargetId }),
      ...(event.laneId === undefined
        ? {}
        : { laneId: event.laneId }),
      ...(event.harnessSessionId === undefined
        ? {}
        : { harnessSessionId: event.harnessSessionId }),
    },
  });
}

function aideResourceRef(resource: AideResourceObservation): ResourceRef {
  return Object.freeze({
    ...AIDE_TURN_RESOURCE_TYPE,
    namespace: AIDE_SYSTEM_NAMESPACE,
    name: resource.metadata.resourceId,
    uid: resource.metadata.sourceEventId,
  });
}

/**
 * Event Ledger 派生出的只读 Aide Resource 索引。它不创建第二份事实，也不提供 patch API。
 */
export class AideResourceIndex {
  readonly aideSessionId: string;
  readonly session: Readonly<Pick<SessionHandle, "id" | "dir">>;
  private readonly turns = new Map<
    string,
    AideResourceObservation<typeof AIDE_TURN_RESOURCE_KIND>
  >();
  private readonly listeners = new Set<(resource: AnyAideResourceObservation) => void>();
  private readonly unsubscribeSession: () => void;
  private closed = false;

  constructor(options: AideResourceIndexOptions) {
    this.aideSessionId = options.session.id;
    this.session = Object.freeze({
      id: options.session.id,
      dir: options.session.dir,
    });
    for (const event of options.session.ledger.read()) this.project(event, false);
    this.unsubscribeSession = options.session.subscribe((event) => {
      this.project(event, true);
    });
  }

  get<K extends AideResourceKind>(
    kind: K,
    resourceId: string,
  ): AideResourceObservation<K> {
    this.assertKind(kind);
    const resource = this.turns.get(resourceId);
    if (!resource) {
      throw new Error(`Aide resource not found: ${kind}/${resourceId}`);
    }
    return resource as AideResourceObservation<K>;
  }

  list<K extends AideResourceKind>(kind: K): AideResourceObservation<K>[] {
    this.assertKind(kind);
    return [...this.turns.values()]
      .sort((left, right) => left.metadata.revision - right.metadata.revision)
      .map((resource) => resource as AideResourceObservation<K>);
  }

  subscribe(listener: (resource: AnyAideResourceObservation) => void): () => void {
    if (this.closed) throw new Error("Aide resource index is closed");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeSession();
    this.listeners.clear();
  }

  private project(event: AnyEventEnvelope, notify: boolean): void {
    if (event.kind !== "_aide_turn_summary") return;
    const resource = turnResource(event);
    const current = this.turns.get(resource.metadata.resourceId);
    if (current && current.metadata.revision >= resource.metadata.revision) return;
    this.turns.set(resource.metadata.resourceId, resource);
    if (!notify || this.closed) return;
    for (const listener of this.listeners) listener(resource);
  }

  private assertKind(kind: string): asserts kind is AideResourceKind {
    if (kind !== AIDE_TURN_RESOURCE_KIND) {
      throw new Error(`unsupported Aide resource kind: ${kind}`);
    }
  }
}

export interface AideResourceControllerOptions<K extends AideResourceKind> {
  resources: AideResourceIndex;
  pluginInstanceId: string;
  namespace: ResourceNamespace;
  resourceKind: K;
  sources?: readonly ControllerSource[];
  watches?: readonly Watch[];
  reconcile(
    context: ReconcileContext,
    resource: Readonly<AideResourceObservation<K>>,
  ): Promise<ReconcileResult | void>;
  maxConcurrency?: number;
  now?: () => Date;
  /** 每次执行前读取最新 AideSession 只读视图。 */
  snapshot?: (key: ReconcileKey, resource: ResourceRef) => ReconcileSnapshot;
  invokeVerb?: InvokeVerb;
  executeReconcile?: <T>(
    scope: ExecutionScope,
    localLease: ReconcileCapacityLease,
    execute: () => Promise<T>,
  ) => Promise<T>;
  onReconcileSuccess?(key: ReconcileKey, nextReconcileAt: Date | null): void;
  onReconcileError?(key: ReconcileKey, error: unknown): void;
  onWatchError?(change: ResourceClientChange, error: unknown): void;
  retry?: ControllerRetryOptions;
}

function validatedResult(result: ReconcileResult | void): ReconcileResult {
  if (!result) return {};
  if (
    result.requeueAfterMs !== undefined &&
    (!Number.isSafeInteger(result.requeueAfterMs) || result.requeueAfterMs < 1)
  ) {
    throw new Error("reconcile requeueAfterMs must be a positive integer");
  }
  return result;
}

/**
 * 一个 Plugin 对一种 Aide-owned Resource 的只读 Controller。
 * 重放和 live event 最终都只入同一 keyed queue，Controller 每次重新读取最新 Resource。
 */
export class AideResourceController<K extends AideResourceKind> {
  readonly scope: ReconcileScope;
  readonly sources: readonly ControllerSource[];
  readonly watches: readonly Watch[];
  private readonly resources: AideResourceIndex;
  private readonly resourceKind: K;
  private readonly reconcileResource: AideResourceControllerOptions<K>["reconcile"];
  private readonly now: () => Date;
  private readonly snapshot: NonNullable<AideResourceControllerOptions<K>["snapshot"]>;
  private readonly invokeVerb: InvokeVerb;
  private readonly executeReconcile: NonNullable<
    AideResourceControllerOptions<K>["executeReconcile"]
  >;
  private readonly onWatchError?: AideResourceControllerOptions<K>["onWatchError"];
  private readonly queue: ReconcileQueue;
  private readonly retry?: ReconcileRetry;
  private closed = false;

  constructor(options: AideResourceControllerOptions<K>) {
    if (!options.pluginInstanceId.trim()) {
      throw new Error("pluginInstanceId must not be empty");
    }
    this.resources = options.resources;
    this.resourceKind = options.resourceKind;
    validateWatches(options.watches);
    this.now = options.now ?? (() => new Date());
    validateSources(options.sources, this.now());
    this.sources = Object.freeze([...(options.sources ?? [])]);
    this.watches = Object.freeze([...(options.watches ?? [])]);
    if (this.sources.some((source) => source.type === "resource")) {
      throw new Error(
        "Controller resource Sources cannot materialize Aide-owned Resources",
      );
    }
    this.resources.list(options.resourceKind);
    this.reconcileResource = options.reconcile;
    this.snapshot =
      options.snapshot ??
      (() => emptyReconcileSnapshot(options.resources.aideSessionId));
    this.invokeVerb = options.invokeVerb ?? (async () => {
      throw new Error("Aide Resource Controller has no reconcile capability host");
    });
    this.scope = Object.freeze({
      aideSessionId: options.resources.aideSessionId,
      pluginInstanceId: options.pluginInstanceId,
      namespace: options.namespace,
      resourceApiVersion: AIDE_TURN_RESOURCE_TYPE.apiVersion,
      resourceKind: options.resourceKind,
      resourceOwner: "aide",
    });
    this.executeReconcile = options.executeReconcile ??
      (async <T>(
        _scope: ExecutionScope,
        _localLease: ReconcileCapacityLease,
        execute: () => Promise<T>,
      ) => await execute());
    this.onWatchError = options.onWatchError;
    if (options.retry) {
      this.retry = new ReconcileRetry({
        ...options.retry,
      });
    }
    this.queue = new ReconcileQueue({
      execute: (key, localLease) => {
        const executionScope = Object.freeze({
          aideSessionId: key.aideSessionId,
          pluginInstanceId: key.pluginInstanceId,
          namespace: this.scope.namespace as ResourceNamespace,
          executionId: newId("pex"),
        });
        return this.executeReconcile(executionScope, localLease, async () => {
          if (this.closed) throw new Error("plugin Controller is closed");
          const resource = this.resources.get(this.resourceKind, key.resourceId);
          const resourceRef = aideResourceRef(resource);
          const snapshot = deepFreeze(this.snapshot(key, resourceRef));
          if (snapshot.session.aideSessionId !== this.scope.aideSessionId) {
            throw new Error(
              `ReconcileSnapshot aideSessionId must be ${this.scope.aideSessionId}, got ${snapshot.session.aideSessionId}`,
            );
          }
          const context = createReconcileContext(
            snapshot,
            executionScope,
            this.invokeVerb,
          );
          const result = validatedResult(
            await this.reconcileResource(context, resource),
          );
          const now = this.now();
          if (Number.isNaN(now.getTime())) {
            throw new Error("plugin Controller now() returned an invalid Date");
          }
          const nextReconcileAt =
            result.requeueAfterMs === undefined
              ? null
              : new Date(now.getTime() + result.requeueAfterMs);
          options.onReconcileSuccess?.(key, nextReconcileAt);
          if (this.retry) this.retry.succeeded(key, nextReconcileAt);
        });
      },
      maxConcurrency: options.maxConcurrency,
      onError: (key, error) => {
        if (this.retry) this.retry.failed(key, error);
        else options.onReconcileError?.(key, error);
      },
    });
  }

  enqueue(key: ReconcileKey): Promise<void> {
    try {
      this.assertOwns(key);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.queue.enqueue(Object.freeze({ ...key, resourceOwner: "aide" }));
  }

  cronSources(): readonly CronSource[] {
    return this.sources.filter(
      (source): source is CronSource =>
        source.type === "cron",
    );
  }

  async reconcileKeys(
    change: ResourceClientChange,
  ): Promise<readonly ReconcileKey[]> {
    if (
      change.pluginInstanceId !== this.scope.pluginInstanceId ||
      change.resource.metadata.namespace !== this.scope.namespace
    ) {
      return [];
    }
    let requests;
    try {
      requests = await watchRequests(this.watches, change);
    } catch (error) {
      this.onWatchError?.(change, error);
      return [];
    }
    return Object.freeze(requests.map((request) => Object.freeze({
      ...this.scope,
      resourceId: request.name,
    })));
  }

  close(): void {
    this.closed = true;
    this.retry?.close();
    this.queue.close();
  }

  initialReconciles(): ReconcileKey[] {
    return this.resources.list(this.resourceKind).map((resource) =>
      Object.freeze({
        ...this.scope,
        resourceId: resource.metadata.resourceId,
      }),
    );
  }

  resourceKeys(): ReconcileKey[] {
    return this.initialReconciles();
  }

  scheduledReconciles(): ScheduledReconcile[] {
    return [];
  }

  /** Exact incarnation guard for Event-driven wakeups such as HarnessInvocation results. */
  ownsResource(resource: ResourceRef): boolean {
    if (
      resource.apiVersion !== AIDE_TURN_RESOURCE_TYPE.apiVersion ||
      resource.kind !== this.resourceKind ||
      resource.namespace !== AIDE_SYSTEM_NAMESPACE
    ) {
      return false;
    }
    try {
      return aideResourceRef(
        this.resources.get(this.resourceKind, resource.name),
      ).uid === resource.uid;
    } catch {
      return false;
    }
  }

  private assertOwns(key: ReconcileKey): void {
    if (
      key.aideSessionId !== this.scope.aideSessionId ||
      key.pluginInstanceId !== this.scope.pluginInstanceId ||
      key.namespace !== this.scope.namespace ||
      key.resourceApiVersion !== this.scope.resourceApiVersion ||
      key.resourceKind !== this.scope.resourceKind ||
      reconcileResourceOwner(key) !== "aide"
    ) {
      throw new Error(
        `reconcile key is outside controller scope: ${key.aideSessionId}/${key.pluginInstanceId}/${key.resourceApiVersion}/${key.resourceKind}/${key.resourceId}`,
      );
    }
  }
}
