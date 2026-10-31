import { ResourceAlreadyExists } from "@compforge/aide-plugin";
import { ResourceVersionConflict, ResourceIncarnationChanged } from "@compforge/aide-plugin";
import jsonPatch from "fast-json-patch";
import mergePatch from "json-merge-patch";
import { ResourceStorage } from "../../resource/storage.ts";
import { assertPathSegment, assertResourceUid, validateResourceType } from "./type.ts";
import { equalResourceValue, resourceJSON, cloneResourceValue } from "../../../resource/value.ts";
import { createHash } from "node:crypto";
import { join } from "node:path";

import type { Resource, ResourcePatch, ResourceListOptions, ResourcePageOptions, ResourcePage, ResourceNamespace, ResourceOwnerReference, ResourceType } from "@compforge/aide-plugin";

import { newId } from "../../event/ids.ts";
import { withAsyncFileLock, withFileLock } from "../../store/file-lock.ts";
import {
  namespaceContains,
  parseResourceNamespace,
} from "../namespace.ts";

export type PluginResource<
  TSpec = Record<string, unknown>,
  TStatus = Record<string, unknown>,
> = Resource<TSpec, TStatus>;

export interface PluginResourceStoreOptions {
  home: string;
  pluginInstanceId: string;
}

interface MutationOptions {
  controllerName?: string;
  expectedResourceVersion?: string;
  expectedUid?: string;
  namespace?: ResourceNamespace;
}

interface CreateResource<TSpec, TStatus> {
  type: ResourceType;
  name?: string;
  namespace?: ResourceNamespace;
  labels?: Readonly<Record<string, string>>;
  annotations?: Readonly<Record<string, string>>;
  owner?: ResourceOwnerReference;
  spec: TSpec;
  status?: TStatus;
}

interface EnsureResource<TSpec> {
  type: ResourceType;
  name: string;
  namespace?: ResourceNamespace;
  labels?: Readonly<Record<string, string>>;
  annotations?: Readonly<Record<string, string>>;
  owner?: ResourceOwnerReference;
  spec: TSpec;
}

interface EnsureResourceResult<TSpec, TStatus> {
  resource: PluginResource<TSpec, TStatus>;
  created: boolean;
}

export interface ResourceDeletionUpdate {
  readonly oldResource: PluginResource<unknown, unknown>;
  readonly resource: PluginResource<unknown, unknown>;
}

interface ResourceControl {
  nextReconcileAt?: string;
  controllerDue?: Record<string, string>;
}

interface StoredPluginResource<TSpec, TStatus> {
  [key: string]: unknown;
  object: PluginResource<TSpec, TStatus>;
  control: ResourceControl;
}

const RESOURCE_VERSION = /^[1-9][0-9]*$/;
const LABEL_NAME =
  /^[A-Za-z0-9](?:[-A-Za-z0-9_.]*[A-Za-z0-9])?$/;
const DNS_SUBDOMAIN =
  /^[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;

function sameResourceType(
  left: ResourceType,
  right: ResourceType,
): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind
  );
}

function jsonObject<T>(name: string, value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  let text: string;
  try {
    text = JSON.stringify(resourceJSON(value));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must contain only JSON values: ${detail}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (!equalResourceValue(value, parsed)) {
    throw new Error(`${name} must contain only lossless JSON values`);
  }
  return cloneResourceValue(value);
}

function annotationMap(
  name: string,
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return;
  const map = jsonObject(name, value);
  for (const [key, entry] of Object.entries(map)) {
    if (!key || typeof entry !== "string") {
      throw new Error(`${name} must contain only non-empty keys and string values`);
    }
  }
  return map;
}

function annotationMapPatch(
  name: string,
  value: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string | null>> {
  const map = jsonObject(name, value);
  for (const [key, entry] of Object.entries(map)) {
    if (!key || (typeof entry !== "string" && entry !== null)) {
      throw new Error(`${name} must contain only non-empty keys and string or null values`);
    }
  }
  return map;
}

function labelKey(name: string, key: string): void {
  const parts = key.split("/");
  if (parts.length > 2) {
    throw new Error(`${name} key ${JSON.stringify(key)} must contain at most one "/"`);
  }
  const labelName = parts.at(-1)!;
  if (labelName.length < 1 || labelName.length > 63 || !LABEL_NAME.test(labelName)) {
    throw new Error(`${name} key ${JSON.stringify(key)} has an invalid label name`);
  }
  const prefix = parts.length === 2 ? parts[0]! : undefined;
  if (
    prefix !== undefined &&
    (prefix.length < 1 || prefix.length > 253 || !DNS_SUBDOMAIN.test(prefix) ||
      prefix.split(".").some((part) => part.length > 63))
  ) {
    throw new Error(`${name} key ${JSON.stringify(key)} has an invalid DNS prefix`);
  }
}

function labelValue(name: string, key: string, value: string): void {
  if (
    value.length > 63 ||
    (value.length > 0 && !LABEL_NAME.test(value))
  ) {
    throw new Error(`${name} value for ${JSON.stringify(key)} is not a valid label value`);
  }
}

function labelMap(
  name: string,
  value: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return;
  const map = jsonObject(name, value);
  for (const [key, entry] of Object.entries(map)) {
    if (typeof entry !== "string") {
      throw new Error(`${name} must contain only string values`);
    }
    labelKey(name, key);
    labelValue(name, key, entry);
  }
  return map;
}

function labelMapPatch(
  name: string,
  value: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string | null>> {
  const map = jsonObject(name, value);
  for (const [key, entry] of Object.entries(map)) {
    if (typeof entry !== "string" && entry !== null) {
      throw new Error(`${name} must contain only string or null values`);
    }
    labelKey(name, key);
    if (entry !== null) labelValue(name, key, entry);
  }
  return map;
}

function containsStringMap(
  current: Readonly<Record<string, string>> | undefined,
  expected: Readonly<Record<string, string>> | undefined,
): boolean {
  return expected === undefined ||
    Object.entries(expected).every(([key, value]) => current?.[key] === value);
}

function applyStringMapPatch(
  current: Readonly<Record<string, string>> | undefined,
  patch: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string>> | undefined {
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

function positiveInteger(name: string, value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function resourceVersion(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !RESOURCE_VERSION.test(value)) {
    throw new Error(`${name} must be an opaque positive version`);
  }
}

function nextResourceVersion(current: string): string {
  const next = BigInt(current) + 1n;
  return next.toString();
}

function isoTimestamp(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
}


export class PluginResourceStore {
  private readonly lockDir: string;
  readonly storage: ResourceStorage;
  readonly scope: string;
  readonly pluginInstanceId: string;

  constructor(options: PluginResourceStoreOptions) {
    assertPathSegment("pluginInstanceId", options.pluginInstanceId);
    this.lockDir = join(options.home, "locks", "resources");
    this.pluginInstanceId = options.pluginInstanceId;
    this.scope = options.pluginInstanceId;
    this.storage = ResourceStorage.open(options.home);
  }

  create<TSpec, TStatus = Record<string, unknown>>(
    input: CreateResource<TSpec, TStatus>,
  ): PluginResource<TSpec, TStatus> {
    const type = validateResourceType(input.type);
    const name = input.name ?? newId("pr");
    const namespace = this.resourceNamespace(input.namespace ?? "v1");
    const labels = labelMap("metadata.labels", input.labels);
    const annotations = annotationMap(
      "metadata.annotations",
      input.annotations,
    );
    if (!name || name.length > 1024) throw new Error("Invalid resource name");
    const owner = this.ownerReference(input.owner, type, name, namespace);
    const path = this.resourceKey(type, name, namespace);
    return this.storage.transaction(() => withFileLock(this.lockPath(path), () => {
      if (this.storage.has(path)) {
        throw new ResourceAlreadyExists(`plugin resource already exists: ${type.kind}/${name}`);
      }
      this.assertOwnerActive(owner);
      const stored = this.initialStoredResource<TSpec, TStatus>({
        type,
        name,
        namespace,
        labels,
        annotations,
        owner,
        spec: input.spec,
        status: input.status ?? ({} as TStatus),
      });
      this.storage.write(path, this.scope, stored);
      return stored.object;
    }));
  }

  /**
   * Materializes a Source-owned Resource identity once. Repeated observations
   * are wakeups, not implicit spec updates.
   */
  ensure<TSpec, TStatus = Record<string, unknown>>(
    input: EnsureResource<TSpec>,
  ): EnsureResourceResult<TSpec, TStatus> {
    const type = validateResourceType(input.type);
    const name = input.name;
    const namespace = this.resourceNamespace(input.namespace ?? "v1");
    const labels = labelMap("metadata.labels", input.labels);
    const annotations = annotationMap(
      "metadata.annotations",
      input.annotations,
    );
    const spec = jsonObject("spec", this.storage.definition(this.pluginInstanceId, type).schema.spec.parse(input.spec)) as TSpec;
    if (!name || name.length > 1024) throw new Error("Invalid resource name");
    const owner = this.ownerReference(input.owner, type, name, namespace);
    const path = this.resourceKey(type, name, namespace);
    return this.storage.transaction(() => withFileLock(this.lockPath(path), () => {
      if (!this.storage.has(path)) {
        this.assertOwnerActive(owner);
        const stored = this.initialStoredResource<TSpec, TStatus>({
          type,
          name,
          namespace,
          labels,
          annotations,
          owner,
          spec,
          status: {} as TStatus,
        });
        this.storage.write(path, this.scope, stored);
        return { resource: stored.object, created: true };
      }
      const current = this.readCurrentStored<TSpec, TStatus>(
        type,
        name,
        namespace,
      ).object;
      if (
        !equalResourceValue(current.spec, spec) ||
        !containsStringMap(current.metadata.labels, labels) ||
        !containsStringMap(current.metadata.annotations, annotations) ||
        !equalResourceValue(current.metadata.owner, owner)
      ) {
        throw new Error(
          `Controller Source input conflicts with existing Resource: ${type.kind}/${name}`,
        );
      }
      return { resource: current, created: false };
    }));
  }

  get<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace = "v1",
  ): PluginResource<TSpec, TStatus> {
    this.storage.read(this.resourceKey(type, name, namespace), true);
    return this.readStored<TSpec, TStatus>(type, name, namespace).object;
  }

  find<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace = "v1",
  ): PluginResource<TSpec, TStatus> | undefined {
    validateResourceType(type);
    if (!name || name.length > 1024) throw new Error("Invalid resource name");
    const canonical = this.resourceNamespace(namespace);
    if (!this.storage.read(this.resourceKey(type, name, canonical), true)) return;
    return this.readCurrentStored<TSpec, TStatus>(type, name, canonical).object;
  }

  list<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
    options: ResourceListOptions = {},
  ): PluginResource<TSpec, TStatus>[] {
    validateResourceType(type);
    const namespace = this.resourceNamespace(options.namespace ?? "v1");
    const matchLabels = labelMap(
      "resource list matchLabels",
      options.matchLabels,
    );
    const namespaces = options.includeDescendants
      ? this.managedNamespaces().filter((candidate) =>
          namespaceContains(namespace, candidate)
        )
      : [namespace];
    return namespaces.flatMap((candidate) => [...(options.matchIndex ? this.storage.indexedKeys(this.scope, type, this.kindPrefix(type, candidate), options.matchIndex.name, options.matchIndex.value) : this.storage.keys(this.scope, this.kindPrefix(type, candidate)))]
      .map((key) => this.readStored<TSpec, TStatus>(type, decodeURIComponent(key.slice(key.lastIndexOf("/") + 1)), candidate).object))
      .filter((resource) =>
        containsStringMap(resource.metadata.labels, matchLabels)
      )
      .sort((left, right) =>
        left.metadata.namespace.localeCompare(right.metadata.namespace) ||
        left.metadata.name.localeCompare(right.metadata.name)
      );
  }

  page<S, T>(type: ResourceType, options: ResourcePageOptions): ResourcePage<S, T> {
    validateResourceType(type);
    const namespace = this.resourceNamespace(options.namespace ?? "v1");
    const matchLabels = labelMap("resource list matchLabels", options.matchLabels);
    return this.storage.page<S, T>(this.scope, type, { ...options, namespace, matchLabels });
  }

  /** @spec Desired state and its initial observation commit atomically under one resource version. */
  replace<TSpec, TStatus>(type: ResourceType, name: string, spec: TSpec, status: TStatus, options: MutationOptions = {}): PluginResource<TSpec, TStatus> {
    const desired = this.storage.definition(this.scope, type).schema.spec.parse(jsonObject("spec", spec)) as TSpec;
    const observed = this.storage.definition(this.scope, type).schema.status.parse(jsonObject("status", status)) as TStatus;
    return this.mutate<TSpec, TStatus>(type, name, options, (current) => {
      const specChanged = !equalResourceValue(current.object.spec, desired);
      if (!specChanged && equalResourceValue(current.object.status, observed)) return current;
      return { ...current, object: { ...current.object, spec: desired, status: observed,
        metadata: { ...current.object.metadata,
          generation: current.object.metadata.generation + (specChanged ? 1 : 0),
          resourceVersion: nextResourceVersion(current.object.metadata.resourceVersion) } } };
    }).object;
  }

  replaceSpec<TSpec, TStatus = Record<string, unknown>>(
    type: ResourceType,
    name: string,
    spec: TSpec,
    options: MutationOptions = {},
  ): PluginResource<TSpec, TStatus> {
    const nextSpec = this.storage.definition(this.scope, type).schema.spec.parse(jsonObject("spec", spec)) as TSpec;
    return this.mutate<TSpec, TStatus>(type, name, options, (current) => {
      if (equalResourceValue(current.object.spec, nextSpec)) return current;
      return {
        ...current,
        object: {
          ...current.object,
          metadata: {
            ...current.object.metadata,
            generation: current.object.metadata.generation + 1,
            resourceVersion: nextResourceVersion(
              current.object.metadata.resourceVersion,
            ),
          },
          spec: nextSpec,
        },
      };
    }).object;
  }

  /** @spec Patches apply to the transaction-local object; immutable metadata is never writable.
   * @case tests/resource-patch.test.ts
   * @link docs/plugin/resource.md#更新操作与并发
   */
  patch<TSpec, TStatus>(type: ResourceType, name: string, patch: ResourcePatch, options: MutationOptions = {}): PluginResource<TSpec, TStatus> {
    const writable = (path: string) => /^\/(spec|status)(\/|$)/.test(path) || /^\/metadata\/(labels|annotations)(\/|$)/.test(path);
    if (patch.type === "json") {
      for (const op of patch.value) {
        if (op.op !== "test" && (!writable(op.path) || (op.op === "move" && !writable(op.from))))
          throw new Error(`Invalid resource patch path: ${op.path}`);
      }
    } else if (patch.type === "merge") {
      for (const key of Object.keys(patch.value)) {
        if (!["spec", "status", "metadata"].includes(key)) throw new Error(`Invalid resource patch field: ${key}`);
      }
      if (patch.value.metadata !== undefined) {
        const metadata = jsonObject("metadata patch", patch.value.metadata as Record<string, unknown>);
        if (Object.keys(metadata).some(k => !["labels", "annotations"].includes(k))) throw new Error("Resource identity metadata is immutable");
      }
    } else throw new Error("Unknown resource patch type");
    return this.mutate<TSpec, TStatus>(type, name, options, current => {
      const document = resourceJSON(current.object);
      const next = (patch.type === "merge" ? mergePatch.apply(document, resourceJSON(patch.value))
        : jsonPatch.applyPatch(document, resourceJSON(patch.value) as jsonPatch.Operation[], true, true).newDocument) as PluginResource<TSpec, TStatus>;
      this.validateObject(type, name, current.object.metadata.namespace as ResourceNamespace, next);
      const definition = this.storage.definition(this.scope, type);
      (next as { spec: TSpec }).spec = definition.schema.spec.parse(jsonObject("spec", next.spec));
      (next as { status: TStatus }).status = definition.schema.status.parse(jsonObject("status", next.status));
      if (equalResourceValue(current.object, next)) {
        this.storage.validateChange(this.scope, current.object, next);
        return current;
      }
      return { ...current, object: { ...next, metadata: { ...next.metadata,
        generation: current.object.metadata.generation + Number(!equalResourceValue(current.object.spec, next.spec)),
        resourceVersion: nextResourceVersion(current.object.metadata.resourceVersion),
      } } };
    }).object;
  }

  patchStatus<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType, name: string, patch: Partial<TStatus>, options: MutationOptions = {},
  ): PluginResource<TSpec, TStatus> {
    return this.patch(type, name, { type: "merge", value: { status: jsonObject("status patch", patch) } }, options);
  }

  patchMetadata<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
    name: string,
    patch: {
      readonly labels?: Readonly<Record<string, string | null>>;
      readonly annotations?: Readonly<Record<string, string | null>>;
    },
    options: MutationOptions = {},
  ): PluginResource<TSpec, TStatus> {
    const metadataPatch = jsonObject("metadata patch", patch);
    const labelPatch = metadataPatch.labels === undefined
      ? undefined
      : labelMapPatch("metadata labels patch", metadataPatch.labels);
    const annotationPatch = metadataPatch.annotations === undefined
      ? undefined
      : annotationMapPatch(
        "metadata annotations patch",
        metadataPatch.annotations,
      );
    return this.mutate<TSpec, TStatus>(type, name, options, (current) => {
      const labels = labelPatch === undefined
        ? current.object.metadata.labels
        : applyStringMapPatch(current.object.metadata.labels, labelPatch);
      const annotations = annotationPatch === undefined
        ? current.object.metadata.annotations
        : applyStringMapPatch(
          current.object.metadata.annotations,
          annotationPatch,
        );
      if (
        equalResourceValue(current.object.metadata.labels, labels) &&
        equalResourceValue(current.object.metadata.annotations, annotations)
      ) {
        return current;
      }
      const metadata = {
        ...current.object.metadata,
        resourceVersion: nextResourceVersion(
          current.object.metadata.resourceVersion,
        ),
      };
      if (labels === undefined) delete metadata.labels;
      else metadata.labels = labels;
      if (annotations === undefined) delete metadata.annotations;
      else metadata.annotations = annotations;
      return {
        ...current,
        object: {
          ...current.object,
          metadata,
        },
      };
    }).object;
  }

  /**
   * Persists a deletion request for one Resource and every structural
   * descendant. Existing timestamps are never rewritten.
   */
  requestDeletion(
    type: ResourceType,
    name: string,
    now: Date = new Date(),
    namespace: ResourceNamespace = "v1",
    preconditions?: { uid: string; resourceVersion: string },
  ): readonly ResourceDeletionUpdate[] {
    if (Number.isNaN(now.getTime())) {
      throw new Error("deletion time must be a valid Date");
    }
    return this.storage.transaction(() => {
      const target = this.get<unknown, unknown>(type, name, namespace);
      if (preconditions && (target.metadata.uid !== preconditions.uid || target.metadata.resourceVersion !== preconditions.resourceVersion))
        throw new Error("Resource version conflict before deletion; read it again");
      const updates: ResourceDeletionUpdate[] = [];
      const pending = [target];
      const visited = new Set<string>();
      while (pending.length > 0) {
        const resource = pending.shift()!;
        if (visited.has(resource.metadata.uid)) continue;
        visited.add(resource.metadata.uid);
        if (resource.metadata.deletionTimestamp === undefined) {
          const next = this.mutate<unknown, unknown>(
            resource,
            resource.metadata.name,
            { namespace: resource.metadata.namespace as ResourceNamespace },
            (current) => {
              if (current.object.metadata.deletionTimestamp !== undefined) {
                return current;
              }
              return {
                object: {
                  ...current.object,
                  metadata: {
                    ...current.object.metadata,
                    resourceVersion: nextResourceVersion(
                      current.object.metadata.resourceVersion,
                    ),
                    deletionTimestamp: now.toISOString(),
                  },
                },
                control: {},
              };
            },
          ).object;
          if (
            next.metadata.resourceVersion !==
            resource.metadata.resourceVersion
          ) {
            updates.push(Object.freeze({
              oldResource: resource,
              resource: next,
            }));
          }
        }

        // Mark this node first so create() rejects new dependents before the
        // scan. Repeating the scan also repairs partially propagated requests.
        pending.push(
          ...this.listAll().filter((candidate) => {
            return candidate.metadata.owner?.uid === resource.metadata.uid;
          }),
        );
      }
      return Object.freeze(updates);
    });
  }

  finalizeDeletion(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace = "v1",
  ): PluginResource<unknown, unknown> {
    const resource = this.get<unknown, unknown>(type, name, namespace);
    if (resource.metadata.deletionTimestamp === undefined) {
      throw new Error(
        `plugin resource deletion was not requested: ${type.kind}/${name}`,
      );
    }
    this.remove(type, name, namespace);
    return resource;
  }

  setNextReconcileAt<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
    name: string,
    next: Date | null,
    options: MutationOptions = {},
  ): void {
    if (next && Number.isNaN(next.getTime())) {
      throw new Error("nextReconcileAt must be a valid Date");
    }
    const nextReconcileAt = next?.toISOString();
    this.mutate<TSpec, TStatus>(type, name, options, (current) => {
      if (options.controllerName) {
        const previous = current.control.controllerDue ?? {};
        if (previous[options.controllerName] === nextReconcileAt) return current;
        const controllerDue = { ...previous };
        if (nextReconcileAt) controllerDue[options.controllerName] = nextReconcileAt;
        else delete controllerDue[options.controllerName];
        return { ...current, control: { ...current.control, controllerDue } };
      }
      if (current.control.nextReconcileAt === nextReconcileAt) return current;
      const control = { ...current.control };
      if (nextReconcileAt === undefined) delete control.nextReconcileAt;
      else control.nextReconcileAt = nextReconcileAt;
      return { ...current, control };
    });
  }

  scheduledReconciles(
    type: ResourceType, controllerName?: string,
  ): readonly {
    resource: PluginResource<unknown, unknown>;
    nextReconcileAt: Date;
  }[] {
    validateResourceType(type);
    return this.list<unknown, unknown>(type, {
      namespace: "v1",
      includeDescendants: true,
    }).flatMap((resource) => {
      const stored = this.readStored<unknown, unknown>(
        type,
        resource.metadata.name,
        resource.metadata.namespace as ResourceNamespace,
      );
      const due = controllerName ? stored.control.controllerDue?.[controllerName] : stored.control.nextReconcileAt;
      if (due === undefined) return [];
      return [{
        resource: stored.object,
        nextReconcileAt: new Date(due),
      }];
    });
  }

  /**
   * 只串行化同一 Resource 的 Controller，不阻止用户并发更新 spec。
   * Controller 仍须用 resourceVersion 拒绝基于旧 snapshot 的 status 或调度写入。
   */
  withReconcileLock<T>(
    type: ResourceType,
    name: string,
    reconcile: () => Promise<T>,
    namespace: ResourceNamespace = "v1",
    controllerName?: string,
  ): Promise<T> {
    validateResourceType(type);
    if (!name || name.length > 1024) throw new Error("Invalid resource name");
    return withAsyncFileLock(
      this.lockPath(JSON.stringify([this.resourceKey(type, name, namespace), "reconcile", controllerName ?? ""])),
      reconcile,
    );
  }

  private mutate<TSpec, TStatus>(
    type: ResourceType,
    name: string,
    options: MutationOptions,
    update: (
      current: StoredPluginResource<TSpec, TStatus>,
    ) => StoredPluginResource<TSpec, TStatus>,
  ): StoredPluginResource<TSpec, TStatus> {
    validateResourceType(type);
    if (!name || name.length > 1024) throw new Error("Invalid resource name");
    const namespace = this.resourceNamespace(options.namespace ?? "v1");
    const path = this.resourceKey(type, name, namespace);
    return this.storage.transaction(() => withFileLock(this.lockPath(path), () => {
      const current = this.readStored<TSpec, TStatus>(type, name, namespace);
      if (options.expectedUid !== undefined && current.object.metadata.uid !== options.expectedUid) throw new ResourceIncarnationChanged("Resource incarnation changed before mutation");
      if (
        options.expectedResourceVersion !== undefined &&
        options.expectedResourceVersion !==
          current.object.metadata.resourceVersion
      ) {
        throw new ResourceVersionConflict(
          `plugin resource version conflict: expected ${options.expectedResourceVersion}, current ${current.object.metadata.resourceVersion}`,
        );
      }
      const next = update(current);
      if (!equalResourceValue(current, next)) this.storage.write(path, this.scope, next);
      return next;
    }));
  }

  private readStored<TSpec, TStatus>(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace = "v1",
  ): StoredPluginResource<TSpec, TStatus> {
    validateResourceType(type);
    if (!name || name.length > 1024) throw new Error("Invalid resource name");
    return this.readCurrentStored<TSpec, TStatus>(type, name, namespace);
  }

  private readCurrentStored<TSpec, TStatus>(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace = "v1",
  ): StoredPluginResource<TSpec, TStatus> {
    const canonical = this.resourceNamespace(namespace);
    const path = this.resourceKey(type, name, canonical);
    let parsed: unknown;
    try {
      parsed = this.storage.read(path);
      if (!parsed) throw Object.assign(new Error("Missing resource"), { code: "ENOENT" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`plugin resource not found: ${type.kind}/${name}`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not read plugin resource ${path}: ${detail}`);
    }
    return this.validateStored<TSpec, TStatus>(
      path,
      type,
      name,
      canonical,
      parsed,
    );
  }

  private validateStored<TSpec, TStatus>(
    path: string,
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace,
    value: unknown,
  ): StoredPluginResource<TSpec, TStatus> {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("root must be a JSON object");
      }
      const stored = value as Partial<StoredPluginResource<TSpec, TStatus>>;
      const object = this.validateObject<TSpec, TStatus>(
        type,
        name,
        namespace,
        stored.object,
      );
      const control = this.validateControl(stored.control);
      return { ...stored, object, control };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid plugin resource ${path}: ${detail}`);
    }
  }

  private validateObject<TSpec, TStatus>(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace,
    value: unknown,
  ): PluginResource<TSpec, TStatus> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("object must be a JSON object");
    }
    const resource = value as Partial<PluginResource<TSpec, TStatus>>;
    if (!sameResourceType(resource as ResourceType, type)) {
      throw new Error(
        `apiVersion and kind must be ${type.apiVersion} ${type.kind}`,
      );
    }
    const metadata = resource.metadata;
    if (!metadata || typeof metadata !== "object") {
      throw new Error("metadata must be an object");
    }
    if (metadata.name !== name) throw new Error(`name must be ${name}`);
    if (metadata.namespace !== namespace) {
      throw new Error(`namespace must be ${namespace}`);
    }
    assertResourceUid(metadata.uid);
    positiveInteger("metadata.generation", metadata.generation);
    resourceVersion("metadata.resourceVersion", metadata.resourceVersion);
    isoTimestamp(
      "metadata.creationTimestamp",
      metadata.creationTimestamp,
    );
    labelMap("metadata.labels", metadata.labels);
    annotationMap("metadata.annotations", metadata.annotations);
    this.ownerReference(metadata.owner, type, name, namespace);
    if (metadata.deletionTimestamp !== undefined) {
      isoTimestamp(
        "metadata.deletionTimestamp",
        metadata.deletionTimestamp,
      );
    }
    jsonObject("spec", resource.spec);
    jsonObject("status", resource.status);
    return resource as PluginResource<TSpec, TStatus>;
  }

  private validateControl(value: unknown): ResourceControl {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("control must be an object");
    }
    const control = value as ResourceControl;
    if (control.nextReconcileAt !== undefined) {
      isoTimestamp("control.nextReconcileAt", control.nextReconcileAt);
    }
    for (const due of Object.values(control.controllerDue ?? {})) isoTimestamp("control.controllerDue", due);
    return control;
  }

  private initialStoredResource<TSpec, TStatus>(
    input: {
      type: ResourceType;
      name: string;
      namespace: ResourceNamespace;
      labels?: Readonly<Record<string, string>>;
      annotations?: Readonly<Record<string, string>>;
      owner?: ResourceOwnerReference;
      spec: TSpec;
      status: TStatus;
    },
  ): StoredPluginResource<TSpec, TStatus> {
    const resource: PluginResource<TSpec, TStatus> = {
      apiVersion: input.type.apiVersion,
      kind: input.type.kind,
      metadata: {
        name: input.name,
        namespace: input.namespace,
        uid: newId("pr"),
        generation: 1,
        resourceVersion: "1",
        creationTimestamp: new Date().toISOString(),
        ...(input.owner === undefined ? {} : { owner: input.owner }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.annotations === undefined
          ? {}
          : { annotations: input.annotations }),
      },
      spec: jsonObject("spec", input.spec),
      status: jsonObject("status", input.status),
    };
    return { object: resource, control: {} };
  }

  private ownerReference(
    value: ResourceOwnerReference | undefined,
    dependentType: ResourceType,
    dependentName: string,
    dependentNamespace: ResourceNamespace,
  ): ResourceOwnerReference | undefined {
    if (value === undefined) return;
    const owner = jsonObject("metadata.owner", value);
    validateResourceType(owner);
    assertPathSegment("metadata.owner.name", owner.name);
    assertResourceUid(owner.uid);
    if (owner.namespace !== dependentNamespace) {
      throw new Error(
        `metadata.owner.namespace must be ${dependentNamespace}`,
      );
    }
    if (
      sameResourceType(owner, dependentType) &&
      owner.name === dependentName
    ) {
      throw new Error("plugin resource cannot own itself");
    }
    return owner;
  }

  private assertOwnerActive(
    owner: ResourceOwnerReference | undefined,
  ): void {
    if (!owner) return;
    const resource = this.get(
      owner,
      owner.name,
      owner.namespace as ResourceNamespace,
    );
    if (resource.metadata.uid !== owner.uid) {
      throw new Error(
        `plugin resource owner uid does not match: ${owner.kind}/${owner.name}`,
      );
    }
    if (resource.metadata.deletionTimestamp !== undefined) {
      throw new Error(
        `plugin resource owner is being deleted: ${owner.kind}/${owner.name}`,
      );
    }
  }

  private listAll(): PluginResource<unknown, unknown>[] {
    return [...this.storage.keys(this.scope)].map((key) => this.storage.read(key)!.object);
  }

  private remove(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace,
  ): void {
    validateResourceType(type);
    if (!name || name.length > 1024) throw new Error("Invalid resource name");
    const path = this.resourceKey(type, name, namespace);
    withFileLock(this.lockPath(path), () => {
      if (!this.storage.has(path)) {
        throw new Error(`plugin resource not found: ${type.kind}/${name}`);
      }
      this.storage.remove(path);
    });
  }

  private kindPrefix(type: ResourceType, namespace: ResourceNamespace): string {
    this.storage.definition(this.pluginInstanceId, type);
    validateResourceType(type);
    return [this.pluginInstanceId, this.resourceNamespace(namespace), type.apiVersion, type.kind]
      .map(encodeURIComponent).join("/") + "/";
  }

  key(type: ResourceType, name: string, namespace: ResourceNamespace = "v1"): string {
    return this.resourceKey(type, name, namespace);
  }

  /** @spec Database identity is independent of the host directory and physical lock files.
   * @case tests/plugin-resource.test.ts
   */
  private resourceKey(type: ResourceType, name: string, namespace: ResourceNamespace): string {
    return this.kindPrefix(type, namespace) + encodeURIComponent(name);
  }

  private lockPath(key: string): string {
    return join(this.lockDir, createHash("sha256").update(key).digest("hex"));
  }

  private resourceNamespace(namespace: ResourceNamespace): ResourceNamespace {
    return parseResourceNamespace(namespace);
  }

  private managedNamespaces(): ResourceNamespace[] {
    return [...new Set<ResourceNamespace>(["v1", ...this.listAll().map((r) => r.metadata.namespace as ResourceNamespace)])].sort();
  }
}
