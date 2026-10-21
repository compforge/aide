import type {
  AideSessionResource,
  AideSessionTargetBindingResource,
  AideTargetResource,
  AideTurnResource,
  Resource,
  ResourceListOptions,
  ResourceMergePatch,
  ResourceRef,
  ResourceType,
} from "@compforge/aide-plugin";

import type { HarnessTarget } from "../harness/target.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "@compforge/aide-plugin";
import { InputStore } from "../input/store.ts";
import { TargetCatalog, type TargetProbe } from "./target-catalog.ts";
import {
  sessionTargetBindingMeta,
  type SessionHandle,
  type SessionMeta,
} from "../store/store.ts";
import type { AideResourceIndex } from "./aide-resource-controller.ts";
import {
  AIDE_SESSION_RESOURCE_TYPE,
  AIDE_SESSION_TARGET_BINDING_RESOURCE_TYPE,
  AIDE_SYSTEM_NAMESPACE,
  AIDE_TARGET_RESOURCE_TYPE,
  AIDE_TURN_RESOURCE_TYPE,
} from "./package.ts";
import { resourceTypeKey } from "./resource/type.ts";

export interface AideSessionObservation {
  readonly meta: SessionMeta;
  readonly active: boolean;
}

type WritableBindingSession = Pick<
  SessionHandle,
  "id" | "meta" | "setTargetBinding"
>;

export interface AideResourceProviderOptions {
  readonly inputs?: InputStore;
  readonly session: WritableBindingSession;
  readonly turns?: AideResourceIndex;
  readonly sessions?: () => readonly AideSessionObservation[];
  readonly targets?: () => readonly HarnessTarget[];
  readonly probeTarget?: TargetProbe;
  readonly onProbeError?: (target: HarnessTarget, error: unknown) => void;
  readonly now?: () => Date;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function typeMatches(left: ResourceType, right: ResourceType): boolean {
  return resourceTypeKey(left) === resourceTypeKey(right);
}

function keysAre(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function jsonObject(name: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

/**
 * Core-owned Resource provider. Public clients see ordinary Resources; their
 * authoritative state remains in Session, HarnessTarget configuration, Ledger, and InputStore.
 */
export class AideResourceProvider {
  private readonly inputs?: InputStore;
  private readonly session: WritableBindingSession;
  private readonly turns?: AideResourceIndex;
  private readonly sessions?: AideResourceProviderOptions["sessions"];
  private readonly targets: NonNullable<AideResourceProviderOptions["targets"]>;
  private readonly now: () => Date;
  private readonly targetCreationTimestamp: string;
  private readonly catalogs: TargetCatalog;

  constructor(options: AideResourceProviderOptions) {
    this.inputs = options.inputs;
    this.session = options.session;
    this.turns = options.turns;
    this.sessions = options.sessions;
    this.targets = options.targets ?? (() => []);
    this.now = options.now ?? (() => new Date());
    this.catalogs = new TargetCatalog(options.probeTarget, this.now, options.onProbeError);
    const created = this.now();
    if (Number.isNaN(created.getTime())) {
      throw new Error("Aide Resource provider now() returned an invalid Date");
    }
    this.targetCreationTimestamp = created.toISOString();
  }

  handles(type: ResourceType): boolean {
    return [
      INPUT_TYPE,
      AIDE_TURN_RESOURCE_TYPE,
      AIDE_SESSION_RESOURCE_TYPE,
      AIDE_TARGET_RESOURCE_TYPE,
      AIDE_SESSION_TARGET_BINDING_RESOURCE_TYPE,
    ].some((candidate) => typeMatches(candidate, type));
  }

  async get<TSpec, TStatus>(
    ref: ResourceRef,
  ): Promise<Readonly<Resource<TSpec, TStatus>> | undefined> {
    if (ref.namespace !== AIDE_SYSTEM_NAMESPACE || !this.handles(ref)) return undefined;
    if (typeMatches(ref, INPUT_TYPE)) {
      const input = this.inputs?.get(ref.name);
      return input && (!ref.uid || input.metadata.uid === ref.uid) ? input as unknown as Resource<TSpec, TStatus> : undefined;
    }
    const resource = this.list<TSpec, TStatus>(ref).find(
      (candidate) => candidate.metadata.name === ref.name,
    );
    if (!resource || (ref.uid !== undefined && resource.metadata.uid !== ref.uid)) {
      return undefined;
    }
    if (typeMatches(ref, AIDE_TARGET_RESOURCE_TYPE)) {
      const target = this.configuredTargets().find((candidate) => candidate.id === ref.name)!;
      await this.catalogs.refresh(target);
      return this.targetResource(target) as Readonly<Resource<TSpec, TStatus>>;
    }
    return resource;
  }

  list<TSpec, TStatus>(
    type: ResourceType,
    options?: ResourceListOptions,
  ): readonly Readonly<Resource<TSpec, TStatus>>[] {
    if (
      (options?.namespace !== undefined && options.namespace !== AIDE_SYSTEM_NAMESPACE) ||
      (type.kind !== INPUT_TYPE.kind && Object.keys(options?.matchLabels ?? {}).length > 0)
    ) {
      return [];
    }
    let resources: readonly Resource<unknown, unknown>[];
    if (typeMatches(type, INPUT_TYPE)) {
      resources = this.inputs?.list(this.session.id) ?? [];
    } else if (typeMatches(type, AIDE_SESSION_RESOURCE_TYPE)) {
      resources = this.sessionObservations().map((session) => this.sessionResource(session));
    } else if (typeMatches(type, AIDE_TARGET_RESOURCE_TYPE)) {
      resources = this.configuredTargets().map((target) => this.targetResource(target));
    } else if (typeMatches(type, AIDE_SESSION_TARGET_BINDING_RESOURCE_TYPE)) {
      resources = this.sessionObservations().map((session) => this.bindingResource(session.meta));
    } else if (typeMatches(type, AIDE_TURN_RESOURCE_TYPE)) {
      resources = this.turnResources();
    } else {
      return [];
    }
    return resources as readonly Readonly<Resource<TSpec, TStatus>>[];
  }

  patch<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: ResourceMergePatch,
  ): Readonly<Resource<TSpec, TStatus>> {
    if (!typeMatches(resource, AIDE_SESSION_TARGET_BINDING_RESOURCE_TYPE)) {
      throw new Error(
        `Resource ${resource.apiVersion}/${resource.kind} does not support patch`,
      );
    }
    if (
      resource.metadata.namespace !== AIDE_SYSTEM_NAMESPACE ||
      resource.metadata.name !== this.session.id ||
      resource.metadata.uid !== this.bindingUid(this.session.id)
    ) {
      throw new Error(
        `Plugin may patch only the current SessionTargetBinding ${this.session.id}`,
      );
    }
    if (patch.type !== "merge" || !keysAre(patch.value, ["spec"])) {
      throw new Error("SessionTargetBinding patch may change only spec.targetRef");
    }
    const spec = jsonObject("SessionTargetBinding patch spec", patch.value.spec);
    if (!keysAre(spec, ["targetRef"])) {
      throw new Error("SessionTargetBinding patch may change only spec.targetRef");
    }
    const targetId = spec.targetRef === null
      ? undefined
      : this.targetId(jsonObject("SessionTargetBinding targetRef", spec.targetRef));
    this.session.setTargetBinding(
      targetId,
      resource.metadata.resourceVersion,
      this.now(),
    );
    return this.bindingResource(this.session.meta) as Readonly<Resource<TSpec, TStatus>>;
  }

  create<S, T>(type: ResourceType, name: string, spec: S): Readonly<Resource<S, T>> {
    if (!typeMatches(type, INPUT_TYPE) || !this.inputs) throw new Error(`Cannot create builtin ${type.kind}`);
    return this.inputs.submit(this.session.id, name, spec as InputSpec) as unknown as Resource<S, T>;
  }

  patchStatus<S, T>(resource: Readonly<Resource<S, T>>, patch: Partial<T>): Readonly<Resource<S, T>> {
    if (!typeMatches(resource, INPUT_TYPE) || resource.metadata.namespace !== AIDE_SYSTEM_NAMESPACE || !this.inputs) {
      throw new Error(`Cannot update builtin ${resource.kind}`);
    }
    return this.inputs.update(resource as unknown as Resource<InputSpec, InputStatus>, patch as Partial<InputStatus>) as unknown as Resource<S, T>;
  }

  /**
   * A binding replaces only the conventional family/default coordinate. An
   * explicit Target id remains authoritative, so `/target <id>` is still exact.
   */
  resolveTarget(requestedTargetId: string): string {
    const requested = this.configuredTargets().find((target) => target.id === requestedTargetId);
    const boundId = sessionTargetBindingMeta(this.session.meta).targetId;
    if (!requested || requested.id !== requested.harness || !boundId) {
      return requestedTargetId;
    }
    const bound = this.configuredTargets().find((target) => target.id === boundId);
    return bound?.harness === requested.harness ? bound.id : requestedTargetId;
  }

  /**
   * Make an explicit Target selection authoritative over a same-family binding.
   * Bindings for another Harness family stay intact so a temporary cross-Harness
   * handoff does not discard the Session's established account affinity.
   */
  selectExactTarget(targetId: string): void {
    const targets = this.configuredTargets();
    const requested = targets.find((target) => target.id === targetId);
    if (!requested) throw new Error(`Unknown HarnessTarget: ${targetId}`);

    const binding = sessionTargetBindingMeta(this.session.meta);
    if (!binding.targetId || binding.targetId === requested.id) return;
    const bound = targets.find((target) => target.id === binding.targetId);
    if (bound?.harness !== requested.harness) return;

    this.session.setTargetBinding(
      requested.id,
      String(binding.resourceVersion),
      this.now(),
    );
  }

  private sessionObservations(): readonly AideSessionObservation[] {
    const observed = new Map(
      (this.sessions?.() ?? []).map((session) => [
        session.meta.aideSessionId,
        session,
      ]),
    );
    observed.set(this.session.id, {
      meta: this.session.meta,
      active: true,
    });
    return [...observed.values()].sort((left, right) =>
      left.meta.aideSessionId.localeCompare(right.meta.aideSessionId)
    );
  }

  private configuredTargets(): readonly HarnessTarget[] {
    return [...this.targets()].sort((left, right) => left.id.localeCompare(right.id));
  }

  private sessionResource(observation: AideSessionObservation): AideSessionResource {
    const { meta, active } = observation;
    return deepFreeze({
      ...AIDE_SESSION_RESOURCE_TYPE,
      metadata: {
        name: meta.aideSessionId,
        namespace: AIDE_SYSTEM_NAMESPACE,
        uid: meta.aideSessionId,
        generation: 1,
        resourceVersion: meta.updatedAt ?? meta.createdAt,
        creationTimestamp: meta.createdAt,
      },
      spec: {},
      status: { phase: active ? "Active" : "Inactive" },
    });
  }

  private targetResource(target: HarnessTarget): AideTargetResource {
    const catalog = this.catalogs.snapshot(target.id);
    return deepFreeze({
      ...AIDE_TARGET_RESOURCE_TYPE,
      metadata: {
        name: target.id,
        namespace: AIDE_SYSTEM_NAMESPACE,
        uid: this.targetUid(target.id),
        generation: 1,
        resourceVersion: catalog.version,
        creationTimestamp: this.targetCreationTimestamp,
      },
      spec: { harness: target.harness },
      status: { phase: "Ready", modelCatalog: catalog.value },
    });
  }

  private bindingResource(meta: SessionMeta): AideSessionTargetBindingResource {
    const binding = sessionTargetBindingMeta(meta);
    const targets = this.configuredTargets();
    const selected = binding.targetId === undefined
      ? undefined
      : targets.find((target) => target.id === binding.targetId);
    const targetRef = selected ? this.targetRef(selected.id) : undefined;
    return deepFreeze({
      ...AIDE_SESSION_TARGET_BINDING_RESOURCE_TYPE,
      metadata: {
        name: meta.aideSessionId,
        namespace: AIDE_SYSTEM_NAMESPACE,
        uid: this.bindingUid(meta.aideSessionId),
        generation: binding.generation,
        resourceVersion: String(binding.resourceVersion),
        creationTimestamp: meta.createdAt,
      },
      spec: {
        sessionRef: this.sessionRef(meta.aideSessionId),
        eligibleTargetRefs: targets.map((target) => this.targetRef(target.id)),
        ...(targetRef === undefined ? {} : { targetRef }),
      },
      status: {
        observedGeneration: binding.generation,
        ...(targetRef === undefined ? {} : { effectiveTargetRef: targetRef }),
        phase: binding.targetId === undefined
          ? "Pending"
          : selected
            ? "Bound"
            : "Failed",
      },
    });
  }

  private turnResources(): readonly AideTurnResource[] {
    if (!this.turns) return [];
    return this.turns.list(AIDE_TURN_RESOURCE_TYPE.kind).map((turn) =>
      deepFreeze({
        ...AIDE_TURN_RESOURCE_TYPE,
        metadata: {
          name: turn.metadata.resourceId,
          namespace: AIDE_SYSTEM_NAMESPACE,
          uid: turn.metadata.sourceEventId,
          generation: 1,
          resourceVersion: String(turn.metadata.revision),
          creationTimestamp: turn.metadata.observedAt,
        },
        spec: {},
        status: turn.data as unknown as AideTurnResource["status"],
      }) as AideTurnResource
    );
  }

  private targetId(ref: Record<string, unknown>): string {
    if (
      ref.apiVersion !== AIDE_TARGET_RESOURCE_TYPE.apiVersion ||
      ref.kind !== AIDE_TARGET_RESOURCE_TYPE.kind ||
      ref.namespace !== AIDE_SYSTEM_NAMESPACE ||
      typeof ref.name !== "string"
    ) {
      throw new Error("SessionTargetBinding targetRef must reference a Aide Target");
    }
    const target = this.configuredTargets().find((candidate) => candidate.id === ref.name);
    if (!target) throw new Error(`SessionTargetBinding target is not eligible: ${ref.name}`);
    if (ref.uid !== undefined && ref.uid !== this.targetUid(target.id)) {
      throw new Error(`SessionTargetBinding target uid does not match: ${target.id}`);
    }
    return target.id;
  }

  private sessionRef(sessionId: string): ResourceRef {
    return Object.freeze({
      ...AIDE_SESSION_RESOURCE_TYPE,
      namespace: AIDE_SYSTEM_NAMESPACE,
      name: sessionId,
      uid: sessionId,
    });
  }

  private targetRef(targetId: string): ResourceRef {
    return Object.freeze({
      ...AIDE_TARGET_RESOURCE_TYPE,
      namespace: AIDE_SYSTEM_NAMESPACE,
      name: targetId,
      uid: this.targetUid(targetId),
    });
  }

  private targetUid(targetId: string): string {
    return `target:${targetId}`;
  }

  private bindingUid(sessionId: string): string {
    return `session-target-binding:${sessionId}`;
  }
}
