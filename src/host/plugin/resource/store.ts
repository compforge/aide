import { ResourceStorage, resourceHome, type StoredResource } from "../../resource/storage.ts";
import { assertPathSegment, assertResourceUid, validateResourceType } from "./type.ts";
import { assertSessionId } from "../../store/session-id.ts";
import { isDeepStrictEqual } from "node:util";
import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { basename, join } from "node:path";

import type { Resource, ResourceListOptions, ResourceNamespace, ResourceOwnerReference, ResourceType } from "@compforge/aide-plugin";

import { newId } from "../../event/ids.ts";
import { withAsyncFileLock, withFileLock } from "../../store/file-lock.ts";
import type { SessionHandle } from "../../store/store.ts";
import {
  namespaceContains,
  parseResourceNamespace,
} from "../namespace.ts";

export type PluginResource<
  TSpec = Record<string, unknown>,
  TStatus = Record<string, unknown>,
> = Resource<TSpec, TStatus>;

export interface PluginResourceStoreOptions {
  session?: Pick<SessionHandle, "id" | "dir">;
  home?: string;
  pluginInstanceId: string;
}

interface MutationOptions {
  controllerName?: string;
  expectedResourceVersion?: string;
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
    text = JSON.stringify(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must contain only JSON values: ${detail}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isDeepStrictEqual(value, parsed)) {
    throw new Error(`${name} must contain only lossless JSON values`);
  }
  return parsed as T;
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
  private readonly sessionDir: string;
  readonly storage: ResourceStorage;
  readonly scope: string;
  readonly aideSessionId: string;
  readonly pluginInstanceId: string;

  constructor(options: PluginResourceStoreOptions) {
    if (!options.session && !options.home) throw new Error("Resource store needs a Session or shared home");
    if (options.session) assertSessionId(options.session.id);
    assertPathSegment("pluginInstanceId", options.pluginInstanceId);
    this.sessionDir = options.session?.dir ?? join(options.home!, "shared");
    this.aideSessionId = options.session?.id ?? "";
    this.pluginInstanceId = options.pluginInstanceId;
    this.scope = JSON.stringify([options.session?.id ?? null, options.pluginInstanceId]);
    this.storage = ResourceStorage.open(options.home ?? resourceHome(options.session!.dir));
    const root = this.namespacesDir();
    this.storage.migrate(root, function* () {
      function* files(path: string): Generator<string> {
        if (!existsSync(path)) return;
        for (const item of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, item.name);
          if (item.isDirectory()) yield* files(child);
          else if (item.name.endsWith(".json")) yield child;
        }
      }
      for (const path of files(root)) yield [path, JSON.stringify([options.session?.id ?? null, options.pluginInstanceId]), JSON.parse(readFileSync(path, "utf8")) as StoredResource];
    });
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
    const path = this.resourcePath(type, name, namespace);
    return this.storage.transaction(() => withFileLock(path, () => {
      if (this.storage.has(path)) {
        throw new Error(`plugin resource already exists: ${type.kind}/${name}`);
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
    const path = this.resourcePath(type, name, namespace);
    return this.storage.transaction(() => withFileLock(path, () => {
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
        !isDeepStrictEqual(current.spec, spec) ||
        !containsStringMap(current.metadata.labels, labels) ||
        !containsStringMap(current.metadata.annotations, annotations) ||
        !isDeepStrictEqual(current.metadata.owner, owner)
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
    this.storage.read(this.resourcePath(type, name, namespace), true);
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
    if (!this.storage.read(this.resourcePath(type, name, canonical), true)) return;
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
    return namespaces.flatMap((candidate) => [...this.storage.keys(this.scope, `${this.kindDir(type, candidate)}/`)]
      .map((path) => this.readStored<TSpec,TStatus>(type, decodeURIComponent(basename(path, ".json")), candidate).object))
      .filter((resource) =>
        containsStringMap(resource.metadata.labels, matchLabels)
      )
      .sort((left, right) =>
        left.metadata.namespace.localeCompare(right.metadata.namespace) ||
        left.metadata.name.localeCompare(right.metadata.name)
      );
  }

  /** @spec Desired state and its initial observation commit atomically under one resource version. */
  replace<TSpec, TStatus>(type: ResourceType, name: string, spec: TSpec, status: TStatus, options: MutationOptions = {}): PluginResource<TSpec, TStatus> {
    const desired = jsonObject("spec", spec);
    const observed = jsonObject("status", status);
    return this.mutate<TSpec, TStatus>(type, name, options, (current) => {
      const specChanged = !isDeepStrictEqual(current.object.spec, desired);
      if (!specChanged && isDeepStrictEqual(current.object.status, observed)) return current;
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
    const nextSpec = jsonObject("spec", spec);
    return this.mutate<TSpec, TStatus>(type, name, options, (current) => {
      if (isDeepStrictEqual(current.object.spec, nextSpec)) return current;
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

  patchStatus<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    type: ResourceType,
    name: string,
    patch: Partial<TStatus>,
    options: MutationOptions = {},
  ): PluginResource<TSpec, TStatus> {
    const statusPatch = jsonObject("status patch", patch);
    return this.mutate<TSpec, TStatus>(type, name, options, (current) => {
      const status = { ...current.object.status, ...statusPatch };
      if (isDeepStrictEqual(current.object.status, status)) return current;
      return {
        ...current,
        object: {
          ...current.object,
          metadata: {
            ...current.object.metadata,
            resourceVersion: nextResourceVersion(
              current.object.metadata.resourceVersion,
            ),
          },
          status,
        },
      };
    }).object;
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
        isDeepStrictEqual(current.object.metadata.labels, labels) &&
        isDeepStrictEqual(current.object.metadata.annotations, annotations)
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
  ): readonly ResourceDeletionUpdate[] {
    if (Number.isNaN(now.getTime())) {
      throw new Error("deletion time must be a valid Date");
    }
    return this.storage.transaction(() => {
      const target = this.get<unknown, unknown>(type, name, namespace);
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
      `${this.resourcePath(type, name, namespace)}.reconcile${controllerName ? `.${encodeURIComponent(controllerName)}` : ""}`,
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
    const path = this.resourcePath(type, name, namespace);
    return this.storage.transaction(() => withFileLock(path, () => {
      const current = this.readStored<TSpec, TStatus>(type, name, namespace);
      if (
        options.expectedResourceVersion !== undefined &&
        options.expectedResourceVersion !==
          current.object.metadata.resourceVersion
      ) {
        throw new Error(
          `plugin resource version conflict: expected ${options.expectedResourceVersion}, current ${current.object.metadata.resourceVersion}`,
        );
      }
      const next = update(current);
      if (!isDeepStrictEqual(current, next)) this.storage.write(path, this.scope, next);
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
    const path = this.resourcePath(type, name, canonical);
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
    const path = this.resourcePath(type, name, namespace);
    withFileLock(path, () => {
      if (!this.storage.has(path)) {
        throw new Error(`plugin resource not found: ${type.kind}/${name}`);
      }
      this.storage.remove(path);
    });
  }

  private namespacesDir(): string {
    return join(
      this.sessionDir,
      "plugins",
      this.pluginInstanceId,
      "namespaces",
    );
  }

  private resourcesDir(namespace: ResourceNamespace): string {
    return join(
      this.namespacesDir(),
      encodeURIComponent(namespace),
      "resources",
    );
  }

  private kindDir(type: ResourceType, namespace: ResourceNamespace): string {
    const definition = this.storage.definition(this.pluginInstanceId, type);
    if ((definition.scope === "session") !== Boolean(this.aideSessionId)) throw new Error(`Wrong resource scope: ${type.kind} requires ${definition.scope}`);
    const [group, version] = type.apiVersion.split("/");
    if (!group || !version) {
      throw new Error(`invalid resource apiVersion: ${type.apiVersion}`);
    }
    return join(this.resourcesDir(namespace), group, version, type.kind);
  }

  key(type: ResourceType, name: string, namespace: ResourceNamespace = "v1"): string { return this.resourcePath(type, name, namespace); }

  private resourcePath(
    type: ResourceType,
    name: string,
    namespace: ResourceNamespace,
  ): string {
    return join(
      this.kindDir(type, this.resourceNamespace(namespace)),
      `${encodeURIComponent(name)}.json`,
    );
  }

  private resourceNamespace(namespace: ResourceNamespace): ResourceNamespace {
    return parseResourceNamespace(namespace);
  }

  private managedNamespaces(): ResourceNamespace[] {
    return [...new Set<ResourceNamespace>(["v1", ...this.listAll().map((r) => r.metadata.namespace as ResourceNamespace)])].sort();
  }
}
