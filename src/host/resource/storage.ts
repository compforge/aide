import { cloneResourceValue, equalResourceValue } from "../../resource/value.ts";
import { ResourcePages } from "./pages.ts";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { Resource, ResourceType, ResourceDefinition, ResourceValidationContext, ResourcePageOptions, ResourcePage } from "@compforge/aide-plugin";
import { validateResourceType } from "../plugin/resource/type.ts";

const limit = z.number().int().positive();
const evictionOrder = z.enum(["created", "released", "lru"]);
const Limits = z.object({ maxCount: limit, maxBytes: limit, maxResourceBytes: limit, order: evictionOrder }).strict();
const DefaultLimits = Limits.extend({
  maxCount: limit.default(10_000),
  maxBytes: limit.default(128 * 1024 * 1024),
  maxResourceBytes: limit.default(1024 * 1024),
  order: evictionOrder.default("released"),
});
export const ResourceStorageConfigSchema = z.object({
  maxBytes: limit.default(512 * 1024 * 1024),
  defaults: DefaultLimits.prefault({}),
  kinds: z.record(z.string().regex(/^[^/]+\/[^/]+$/), Limits.partial()).default({}),
  lowWatermark: z.number().min(0.1).max(0.95).default(0.8),
  gc: z.object({ intervalMs: limit.default(60_000), batchSize: limit.max(256).default(16), maxTreeSize: limit.max(4096).default(256) }).strict().prefault({}),
  dedupSeconds: limit.default(7 * 86400),
  maxReceipts: limit.default(100_000),
}).strict();
export type ResourceStorageConfig = z.infer<typeof ResourceStorageConfigSchema>;
export interface StoredResource { object: Resource<unknown, unknown>; control?: object; [key: string]: unknown }
export class ResourceCapacityError extends Error {
  constructor(readonly kind: string, detail?: string) { super(`Resource capacity exhausted: ${kind}${detail ? ` (${detail})` : ""}`); this.name = "ResourceCapacityError"; }
}
const kindKey = (type: ResourceType) => `${type.apiVersion.split("/")[0]}/${type.kind}`;
const databases = new Map<string, ResourceStorage>();
/** @spec All persisted Resources share quotas by Group/Kind across versions and scopes. Reads never materialize a whole database.
 * @spec Only explicitly released, unreferenced resources can be evicted. Protected writes fail closed at capacity.
 * @case tests/resource-capacity.test.ts
 */
export class ResourceStorage {
  readonly db: DatabaseSync;
  readonly pages: ResourcePages;
  private config = ResourceStorageConfigSchema.parse({});
  private readonly definitions = new Map<string, ResourceDefinition>();
  private readonly listeners = new Set<(scope: string, resource: Resource<unknown, unknown>) => void>();
  private readonly writeListeners = new Set<(scope: string, resource: Resource<unknown, unknown>, previous?: Resource<unknown, unknown>) => void>();
  subscribeWrites(listener: (scope: string, resource: Resource<unknown, unknown>, previous?: Resource<unknown, unknown>) => void): () => void { this.writeListeners.add(listener); return () => this.writeListeners.delete(listener); }
  private inTransaction = false;
  private afterCommitCallbacks: Array<() => void> = [];
  private rollbackError: unknown;
  private rollbackOnly = false;
  private readonly pressureListeners = new Set<() => void>();
  readonly capacityPressure = new Set<string>();
  get configuration(): ResourceStorageConfig { return this.config; }
  subscribePressure(listener: () => void): () => void { this.pressureListeners.add(listener); return () => this.pressureListeners.delete(listener); }
  canCollect(scope: string, resource: Resource<unknown, unknown>): boolean {
    return this.definition(scope, resource).retention?.canEvict?.(resource, this.validationContext(scope)) !== false;
  }
  static open(home: string): ResourceStorage {
    const path = resolve(home); let storage = databases.get(path);
    if (!storage || !existsSync(join(path, "resources.sqlite"))) { storage?.db.close(); storage = new ResourceStorage(path); databases.set(path, storage); }
    return storage;
  }
  constructor(readonly home: string) {
    mkdirSync(home, { recursive: true });
    const path = join(home, "resources.sqlite"); this.db = new DatabaseSync(path); chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA cache_size=-4096; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS resources (key TEXT PRIMARY KEY, scope TEXT NOT NULL, kind TEXT NOT NULL, uid TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL, bytes INTEGER NOT NULL, created TEXT NOT NULL, accessed INTEGER NOT NULL, released TEXT);
      CREATE INDEX IF NOT EXISTS resource_kind ON resources(kind, created);
      CREATE INDEX IF NOT EXISTS resource_scope ON resources(scope, key);
      CREATE INDEX IF NOT EXISTS resource_owner ON resources(json_extract(data,'$.object.metadata.owner.uid'));
      CREATE INDEX IF NOT EXISTS resource_released_kind ON resources(kind,released,key);
      CREATE INDEX IF NOT EXISTS resource_released ON resources(released,key);
      CREATE INDEX IF NOT EXISTS resource_gc_deleting ON resources(json_extract(data,'$.object.metadata.deletionTimestamp'),kind,bytes,key);
      CREATE TABLE IF NOT EXISTS resource_refs (source TEXT NOT NULL REFERENCES resources(key) ON DELETE CASCADE, target TEXT NOT NULL, PRIMARY KEY(source,target));
      CREATE INDEX IF NOT EXISTS reference_target ON resource_refs(target);
      CREATE TABLE IF NOT EXISTS resource_indexes (source TEXT NOT NULL REFERENCES resources(key) ON DELETE CASCADE, name TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(source,name,value));
      CREATE INDEX IF NOT EXISTS resource_index_lookup ON resource_indexes(name,value,source);
      CREATE TABLE IF NOT EXISTS resource_payload_sizes (uid TEXT PRIMARY KEY REFERENCES resources(uid) ON DELETE CASCADE, bytes INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, expires INTEGER NOT NULL, value TEXT NOT NULL);`);
    this.pages = new ResourcePages(this.db);
    this.db.exec("UPDATE resources SET released=NULL");
  }
  configure(config?: Partial<ResourceStorageConfig>): void { this.config = ResourceStorageConfigSchema.parse(config ?? {}); }
  subscribe(listener: (scope: string, resource: Resource<unknown, unknown>) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  /** Register immutable declarations once per owner, before opening resources or starting Controllers. */
  register(owner: string, definitions: readonly ResourceDefinition[]): void {
    const keys = new Set<string>();
    for (const definition of definitions) {
      validateResourceType(definition.type);
      const key = this.definitionKey(owner, definition.type);
      if (keys.has(key)) throw new Error(`Resource definition already registered: ${key}`);
      keys.add(key);
      const current = this.definitions.get(key);
      if (current && current !== definition) throw new Error(`Resource definition already registered: ${key}`);
      if (typeof definition.schema?.spec.parse !== "function" || typeof definition.schema?.status.parse !== "function") {
        throw new Error(`Invalid resource definition: ${key}`);
      }
      if (definition.printer && (typeof definition.printer.describe !== "function" || typeof definition.printer.summarize !== "function")) throw new Error(`Invalid resource Printer: ${key}`);
      if (definition.retention && (typeof definition.retention.releasedAt !== "function" || typeof definition.retention.references !== "function")) throw new Error(`Invalid resource retention: ${key}`);
    }
    const added: string[] = [];
    try {
      for (const definition of definitions) {
        for (const name of Object.keys(definition.orderedIndexes ?? {}))
          if (definition.indexes?.[name]) throw new Error(`Duplicate resource index: ${name}`);
        const key = this.definitionKey(owner, definition.type);
        if (!this.definitions.has(key)) { this.definitions.set(key, definition); added.push(key); }
      }
      if (!added.length) return;
      this.transaction(() => {
        for (const definition of definitions) this.pages.invalidate(owner, definition.type);
        for (const row of this.db.prepare("SELECT key,scope,data FROM resources").iterate()) {
          if (row.scope as string !== owner) continue;
          const resource = (JSON.parse(row.data as string) as StoredResource).object;
          if (definitions.some((d) => this.definitionKey(owner, d.type) === this.definitionKey(owner, resource))) {
            this.parse(row.scope as string, resource);
            this.indexLifecycle(row.key as string, row.scope as string, resource);
          }
        }
      });
    } catch (error) { for (const key of added) this.definitions.delete(key); throw error; }
  }
  private definitionKey(owner: string, type: ResourceType): string { return JSON.stringify([owner, type.apiVersion, type.kind]); }
  findDefinition(owner: string, type: ResourceType): ResourceDefinition | undefined { return this.definitions.get(this.definitionKey(owner, type)); }
  definition(owner: string, type: ResourceType): ResourceDefinition {
    const result = this.definitions.get(this.definitionKey(owner, type));
    if (!result) throw new Error(`Unknown resource definition: ${owner} ${type.apiVersion}/${type.kind}`);
    return result;
  }
  private parse(scope: string, resource: Resource<unknown, unknown>): void {
    const definition = this.definition(scope, resource);
    // Parsers may supply defaults or normalize fields; only their canonical output is persisted.
    (resource as { spec: unknown }).spec = definition.schema.spec.parse(resource.spec);
    (resource as { status: unknown }).status = definition.schema.status.parse(resource.status);
  }
  /** @spec Validators read transaction-local dependencies without turning observations into writes.
   * @link docs/plugin/resource.md#事务与删除
   * @case tests/resource-definition.test.ts
   */
  private validationContext(scope: string): ResourceValidationContext {
    return {
      page: <S, T>(type: ResourceType, options: ResourcePageOptions) => this.page<S, T>(scope, type, options),
      get: <S, T>(type: ResourceType, uid: string) => {
        const row = this.db.prepare("SELECT data FROM resources WHERE scope=? AND uid=? AND kind=?").get(scope, uid, kindKey(type));
        if (!row) return;
        const resource = (JSON.parse(row.data as string) as StoredResource).object;
        if (resource.apiVersion !== type.apiVersion || resource.kind !== type.kind) return;
        this.parse(scope, resource);
        return resource as Resource<S, T>;
      },
      list: <S, T>(type: ResourceType, options?: Parameters<ResourceValidationContext["list"]>[1]) => {
        if (options?.matchIndex && !this.definition(scope, type).indexes?.[options.matchIndex.name])
          throw new Error(`Unknown resource index: ${options.matchIndex.name}`);
        const rows = options?.matchIndex
          ? this.db.prepare("SELECT r.data FROM resource_indexes i JOIN resources r ON r.key=i.source WHERE r.scope=? AND r.kind=? AND i.name=? AND i.value=? ORDER BY r.created,r.rowid")
            .all(scope, kindKey(type), options.matchIndex.name, options.matchIndex.value)
          : this.db.prepare("SELECT data FROM resources WHERE scope=? AND kind=? ORDER BY created,rowid").all(scope, kindKey(type));
        return rows.map(row => { const resource = (JSON.parse(row.data as string) as StoredResource).object; this.parse(scope, resource); return resource; })
          .filter(r => r.apiVersion === type.apiVersion && r.kind === type.kind && (!options?.namespace || r.metadata.namespace === options.namespace)) as Resource<S, T>[];
      },
    };
  }
  /** @spec Readers and validators share SQL paging; preceding transaction writes are visible. */
  page<S, T>(scope: string, type: ResourceType, options: ResourcePageOptions): ResourcePage<S, T> {
    const definition = this.definition(scope, type);
    const index = options.matchIndex?.name;
    const ordered = !!(index && definition.orderedIndexes?.[index]);
    if (index && !ordered && !definition.indexes?.[index]) throw new Error(`Unknown resource index: ${index}`);
    return this.transaction(() => {
      const page = this.pages.list(scope, type, options, ordered);
      return { metadata: page.metadata, items: page.keys.map(key => this.read(key)!.object as Resource<S, T>) };
    });
  }
  private indexLifecycle(key: string, scope: string, resource: Resource<unknown, unknown>): void {
    const definition = this.definitions.get(this.definitionKey(scope, resource));
    this.db.prepare("DELETE FROM resource_indexes WHERE source=?").run(key);
    for (const [name, values] of Object.entries(definition?.indexes ?? {})) {
      for (const value of new Set(values(cloneResourceValue(resource)))) {
        if (typeof value !== "string") throw new Error(`Invalid index value: ${name}`);
        this.db.prepare("INSERT INTO resource_indexes VALUES (?,?,?)").run(key, name, value);
      }
    }
    this.db.prepare("DELETE FROM resource_ordered_indexes WHERE source=?").run(key);
    for (const [name, entries] of Object.entries(definition?.orderedIndexes ?? {})) {
      if (definition?.indexes?.[name]) throw new Error(`Duplicate resource index: ${name}`);
      for (const entry of entries(cloneResourceValue(resource))) {
        if (typeof entry.value !== "string" || typeof entry.order !== "string") throw new Error(`Invalid ordered index entry: ${name}`);
        this.db.prepare("INSERT INTO resource_ordered_indexes VALUES (?,?,?,?,?,?,?,?,?)").run(
          key, name, entry.value, scope, resource.apiVersion, resource.kind, resource.metadata.namespace, entry.order, resource.metadata.name);
      }
    }
    let released: string | undefined;
    let refs: readonly string[] = [];
    try {
      const snapshot = cloneResourceValue(resource);
      released = resource.metadata.deletionTimestamp ? undefined : definition?.retention?.releasedAt(snapshot);
      refs = definition?.retention?.references(snapshot) ?? [];
      if (released && !Number.isFinite(Date.parse(released))) throw new Error("Invalid resource release time");
    } catch (error) {
      this.onRetentionError?.(resource, error);
      // Roll back the write or declaration: an unknown edge could otherwise expose a live dependency to collection.
      throw new Error(`Resource retention failed for ${resource.kind}/${resource.metadata.name}`, { cause: error });
    }
    this.db.prepare("UPDATE resources SET released=? WHERE key=?").run(released ?? null, key);
    this.db.prepare("DELETE FROM resource_refs WHERE source=?").run(key);
    for (const target of new Set([...refs, ...(resource.metadata.owner ? [resource.metadata.owner.uid] : [])])) {
      this.db.prepare("INSERT INTO resource_refs VALUES (?,?)").run(key, target);
    }
  }
  onRetentionError?: (resource: Resource<unknown, unknown>, error: unknown) => void;
  has(key: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM resources WHERE key=?").get(key)); }
  /** Decode custom SQL results through the same schema boundary as get/list/page. */
  decode<T extends StoredResource = StoredResource>(scope: string, data: string): T {
    const stored = JSON.parse(data) as T;
    this.parse(scope, stored.object);
    return stored;
  }
  read<T extends StoredResource = StoredResource>(key: string, touch = false): T | undefined {
    const row = this.db.prepare("SELECT scope,data FROM resources WHERE key=?").get(key);
    if (!row) return;
    if (touch) this.db.prepare("UPDATE resources SET accessed=? WHERE key=?").run(Date.now(), key);
    return this.decode<T>(row.scope as string, row.data as string);
  }
  *keys(scope: string, prefix = "", chronological = false): Iterable<string> {
    for (const row of this.db.prepare(`SELECT key FROM resources WHERE scope=? AND substr(key,1,?)=? ORDER BY ${chronological ? "created,rowid" : "key"}`).iterate(scope, prefix.length, prefix)) yield row.key as string;
  }
  *indexedKeys(scope: string, type: ResourceType, prefix: string, name: string, value: string): Iterable<string> {
    if (!this.definition(scope, type).indexes?.[name]) throw new Error(`Unknown resource index: ${name}`);
    for (const row of this.db.prepare("SELECT r.key FROM resource_indexes i JOIN resources r ON r.key=i.source WHERE r.scope=? AND substr(r.key,1,?)=? AND i.name=? AND i.value=? ORDER BY r.created,r.rowid").iterate(scope, prefix.length, prefix, name, value)) yield row.key as string;
  }
  /** @spec Even idempotent patches validate against the current transaction's dependencies without producing a write.
   * @case tests/note-knowledge.test.ts
   * @link docs/plugin/resource.md#更新操作与并发
   */
  validateChange(scope: string, old: Resource<unknown, unknown> | undefined, resource: Resource<unknown, unknown>): void {
    const definition = this.definition(scope, resource);
    const context = this.validationContext(scope);
    const current = cloneResourceValue(resource);
    const result: unknown = old
      ? (!old.metadata.deletionTimestamp && current.metadata.deletionTimestamp
        ? definition.validator?.delete?.(cloneResourceValue(old), context)
        : definition.validator?.update?.(cloneResourceValue(old), current, context))
      : definition.validator?.create?.(current, context);
    if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Resource validation must be synchronous");
  }
  /** @spec Host-only control updates preserve Resource identity, indexes and domain authorization boundaries.
   * @case tests/resource-pagination.test.ts
   * @link docs/plugin/resource.md#更新操作与并发
   */
  write(key: string, scope: string, stored: StoredResource, receipt?: { key: string; value: string }): void {
    this.transaction(() => {
      this.parse(scope, stored.object);
      const prior = this.read(key), old = prior?.object;
      // Host scheduling is outside the Resource object and cannot renew a historical content writer.
      const controlOnly = prior && !equalResourceValue(prior.control, stored.control)
        && equalResourceValue({ ...prior, control: undefined }, { ...stored, control: undefined });
      if (!controlOnly) this.validateChange(scope, old, stored.object);
      const data = JSON.stringify(stored), resource = stored.object;
      const bytes = Buffer.byteLength(data) + Number(this.db.prepare("SELECT bytes FROM resource_payload_sizes WHERE uid=?").get(resource.metadata.uid)?.bytes ?? 0);
      const previous = this.db.prepare("SELECT bytes FROM resources WHERE key=?").get(key);
      const kind = kindKey(resource), limits = { ...this.config.defaults, ...this.config.kinds[kind] };
      const deleting = !!old && !old.metadata.deletionTimestamp && !!resource.metadata.deletionTimestamp;
      // Deletion metadata must be admitted even at capacity, so GC can make progress.
      if (!deleting && bytes > limits.maxResourceBytes && bytes > Number(previous?.bytes ?? 0)) throw new ResourceCapacityError(kind, `record bytes ${bytes}/${limits.maxResourceBytes}`);
      this.db.prepare(`INSERT INTO resources VALUES (?,?,?,?,?,?,?,?,NULL) ON CONFLICT(key) DO UPDATE SET
        data=excluded.data, bytes=excluded.bytes, accessed=excluded.accessed`).run(key, scope, kind, resource.metadata.uid, data, bytes, resource.metadata.creationTimestamp, Date.now());
      if (!controlOnly) this.indexLifecycle(key, scope, resource);
      if (!old || old.metadata.resourceVersion !== resource.metadata.resourceVersion) {
        const snapshot = cloneResourceValue(resource);
        for (const listener of this.writeListeners) {
          this.afterCommit(() => listener(scope, snapshot, old));
        }
      }
      if (receipt) this.addReceipt(receipt.key, receipt.value);
      if (!deleting && (!previous || bytes > Number(previous.bytes))) this.checkCapacity(kind);
    });
  }
  remove(key: string): void { this.db.prepare("DELETE FROM resources WHERE key=?").run(key); }
  /** @spec Deletion preserves stored identity and payload extensions; only scheduling state is cleared. */
  requestDeletion(key: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT scope,data FROM resources WHERE key=?").get(key);
      if (!row) return;
      const stored = this.decode(String(row.scope), String(row.data)), resource = stored.object;
      if (resource.metadata.deletionTimestamp) return;
      this.write(key, String(row.scope), { ...stored, object: { ...resource, metadata: {
        ...resource.metadata, resourceVersion: String(Number(resource.metadata.resourceVersion) + 1), deletionTimestamp: new Date().toISOString(),
      } }, control: {} });
    });
  }
  /** Removal by the collector publishes through the same committed resource dispatcher. */
  collectFinalized(key: string): void {
    this.transaction(() => {
      const row = this.db.prepare("SELECT scope,data FROM resources WHERE key=?").get(key);
      if (!row) return;
      const resource = this.decode(row.scope as string, row.data as string).object;
      if (!resource.metadata.deletionTimestamp) throw new Error("Collection requires a deletion request");
      this.remove(key);
      this.afterCommit(() => { for (const listener of this.listeners) listener(row.scope as string, resource); });
    });
  }
  children(scope: string, uid: string): Resource<unknown, unknown>[] {
    return this.db.prepare("SELECT data FROM resources WHERE scope=? AND json_extract(data,'$.object.metadata.owner.uid')=? ORDER BY key")
      .all(scope, uid).map(row => this.decode(scope, row.data as string).object);
  }
  hasReceipt(key: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM receipts WHERE key=? AND expires>?").get(key, Date.now())); }
  receipt(key: string): string | undefined { return this.db.prepare("SELECT value FROM receipts WHERE key=? AND expires>?").get(key, Date.now())?.value as string | undefined; }
  addReceipt(key: string, value: string): void {
    this.db.prepare("DELETE FROM receipts WHERE expires<=?").run(Date.now());
    if (!this.hasReceipt(key) && Number(this.db.prepare("SELECT count(*) AS n FROM receipts").get()!.n) >= this.config.maxReceipts) throw new ResourceCapacityError("receipts", `count limit ${this.config.maxReceipts}`);
    this.db.prepare("INSERT OR IGNORE INTO receipts VALUES (?,?,?)").run(key, Date.now() + this.config.dedupSeconds * 1000, value);
  }
  /** @spec Admission never collects. Pressure survives rollback and wakes GC outside this synchronous transaction.
   * @link docs/plugin/resource.md#resource-容量与释放
   */
  private checkCapacity(kind: string): void {
    const limits = { ...this.config.defaults, ...this.config.kinds[kind] };
    const usage = this.db.prepare("SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM resources WHERE kind=?").get(kind)!;
    const total = Number(this.db.prepare("SELECT coalesce(sum(bytes),0) AS n FROM resources").get()!.n);
    const kindFull = Number(usage.n) > limits.maxCount || Number(usage.bytes) > limits.maxBytes;
    const totalFull = total > this.config.maxBytes;
    if (!kindFull && !totalFull) return;
    if (kindFull) this.capacityPressure.add(kind);
    if (totalFull) this.capacityPressure.add("*");
    for (const listener of this.pressureListeners) listener();
    throw new ResourceCapacityError(kind, `count ${usage.n}/${limits.maxCount}, kind bytes ${usage.bytes}/${limits.maxBytes}, host bytes ${total}/${this.config.maxBytes}`);
  }
  afterCommit(callback: () => void): void {
    if (this.inTransaction) this.afterCommitCallbacks.push(callback);
    else callback();
  }

  /** @spec Synchronous resource writes commit together; observers only see committed changes. */
  transaction<T>(fn: () => T): T {
    if (this.inTransaction) {
      try {
        const result = fn();
        if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Resource transaction must be synchronous");
        return result;
      } catch (error) { this.rollbackOnly = true; this.rollbackError = error; throw error; }
    }
    this.db.exec("BEGIN IMMEDIATE");
    this.inTransaction = true;
    this.rollbackError = undefined;
    this.rollbackOnly = false;
    let result: T;
    try {
      result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Resource transaction must be synchronous");
      if (this.rollbackOnly) throw this.rollbackError;
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK"); this.afterCommitCallbacks = []; throw error;
    } finally { this.inTransaction = false; }
    const callbacks = this.afterCommitCallbacks; this.afterCommitCallbacks = [];
    for (const callback of callbacks) { try { callback(); } catch { /* already committed */ } }
    return result;
  }
}
