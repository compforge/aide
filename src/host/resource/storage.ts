import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { Resource, ResourceType, ResourceLifecycle } from "@compforge/aide-plugin";

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
  private config = ResourceStorageConfigSchema.parse({});
  private readonly policies = new Map<string, ResourceLifecycle>();
  private readonly listeners = new Set<(scope: string, resource: Resource<unknown, unknown>) => void>();
  private inTransaction = false;
  private afterCommitCallbacks: Array<() => void> = [];
  private rollbackError: unknown;
  private rollbackOnly = false;
  private readonly writtenKeys = new Set<string>();
  private evicted: Array<{ scope: string; resource: Resource<unknown, unknown> }> = [];
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
      CREATE TABLE IF NOT EXISTS resource_refs (source TEXT NOT NULL REFERENCES resources(key) ON DELETE CASCADE, target TEXT NOT NULL, PRIMARY KEY(source,target));
      CREATE INDEX IF NOT EXISTS reference_target ON resource_refs(target);
      CREATE TABLE IF NOT EXISTS receipts (key TEXT PRIMARY KEY, expires INTEGER NOT NULL, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS migrations (key TEXT PRIMARY KEY);`);
  }
  configure(config?: Partial<ResourceStorageConfig>): void { this.config = ResourceStorageConfigSchema.parse(config ?? {}); }
  subscribe(listener: (scope: string, resource: Resource<unknown, unknown>) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  register(scope: string, policy: ResourceLifecycle): void {
    this.policies.set(`${scope}:${kindKey(policy.resourceType)}`, policy);
    this.transaction(() => { for (const key of this.keys(scope)) {
      const row = this.read(key); if (row && kindKey(row.object) === kindKey(policy.resourceType)) this.indexLifecycle(key, scope, row.object);
    } });
  }
  private indexLifecycle(key: string, scope: string, resource: Resource<unknown, unknown>): void {
    const policy = this.policies.get(`${scope}:${kindKey(resource)}`);
    const released = resource.metadata.deletionTimestamp ? undefined : policy?.releasedAt(resource);
    if (released && !Number.isFinite(Date.parse(released))) throw new Error("Invalid resource release time");
    this.db.prepare("UPDATE resources SET released=? WHERE key=?").run(released ?? null, key);
    this.db.prepare("DELETE FROM resource_refs WHERE source=?").run(key);
    const refs = new Set([...(policy?.references(resource) ?? []), ...(resource.metadata.owner ? [resource.metadata.owner.uid] : [])]);
    for (const target of refs) this.db.prepare("INSERT INTO resource_refs VALUES (?,?)").run(key, target);
  }
  has(key: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM resources WHERE key=?").get(key)); }
  read<T extends StoredResource = StoredResource>(key: string, touch = false): T | undefined {
    const row = this.db.prepare("SELECT data FROM resources WHERE key=?").get(key);
    if (!row) return;
    if (touch) this.db.prepare("UPDATE resources SET accessed=? WHERE key=?").run(Date.now(), key);
    return JSON.parse(row.data as string) as T;
  }
  *keys(scope: string, prefix = "", chronological = false): Iterable<string> {
    for (const row of this.db.prepare(`SELECT key FROM resources WHERE scope=? AND substr(key,1,?)=? ORDER BY ${chronological ? "created,rowid" : "key"}`).iterate(scope, prefix.length, prefix)) yield row.key as string;
  }
  write(key: string, scope: string, stored: StoredResource, receipt?: { key: string; value: string }): void {
    this.transaction(() => {
      const data = JSON.stringify(stored), bytes = Buffer.byteLength(data), resource = stored.object;
      const previous = this.db.prepare("SELECT bytes FROM resources WHERE key=?").get(key);
      const kind = kindKey(resource), limits = { ...this.config.defaults, ...this.config.kinds[kind] };
      // Completion/deletion may shrink an oversized pre-existing record even when the host is full.
      if (bytes > limits.maxResourceBytes && bytes > Number(previous?.bytes ?? 0)) throw new ResourceCapacityError(kind, `record bytes ${bytes}/${limits.maxResourceBytes}`);
      this.db.prepare(`INSERT INTO resources VALUES (?,?,?,?,?,?,?,?,NULL) ON CONFLICT(key) DO UPDATE SET
        data=excluded.data, bytes=excluded.bytes, accessed=excluded.accessed`).run(key, scope, kind, resource.metadata.uid, data, bytes, resource.metadata.creationTimestamp, Date.now());
      this.writtenKeys.add(key);
      this.indexLifecycle(key, scope, resource);
      if (receipt) this.addReceipt(receipt.key, receipt.value);
      if (!previous || bytes > Number(previous.bytes)) this.collect(kind, key);
    });
  }
  remove(key: string): void { this.db.prepare("DELETE FROM resources WHERE key=?").run(key); }
  /** Session cleanup already holds its exclusive lease; shared Core facts remain independently owned. */
  removeSession(sessionId: string): void {
    this.transaction(() => {
      const rows = this.db.prepare("SELECT key,scope,data FROM resources WHERE CASE WHEN json_valid(scope) THEN json_extract(scope,'$[0]') END=?");
      for (const row of rows.iterate(sessionId)) {
        this.remove(row.key as string);
        this.evicted.push({ scope: row.scope as string, resource: (JSON.parse(row.data as string) as StoredResource).object });
      }
    });
  }
  hasReceipt(key: string): boolean { return Boolean(this.db.prepare("SELECT 1 FROM receipts WHERE key=? AND expires>?").get(key, Date.now())); }
  receipt(key: string): string | undefined { return this.db.prepare("SELECT value FROM receipts WHERE key=? AND expires>?").get(key, Date.now())?.value as string | undefined; }
  addReceipt(key: string, value: string): void {
    this.db.prepare("DELETE FROM receipts WHERE expires<=?").run(Date.now());
    if (!this.hasReceipt(key) && Number(this.db.prepare("SELECT count(*) AS n FROM receipts").get()!.n) >= this.config.maxReceipts) throw new ResourceCapacityError("receipts", `count limit ${this.config.maxReceipts}`);
    this.db.prepare("INSERT OR IGNORE INTO receipts VALUES (?,?,?)").run(key, Date.now() + this.config.dedupSeconds * 1000, value);
  }
  migrate(id: string, load: () => Iterable<[string, string, StoredResource]>): void {
    if (this.db.prepare("SELECT 1 FROM migrations WHERE key=?").get(id)) return;
    this.transaction(() => {
      for (const [key, scope, stored] of load()) {
        const data = JSON.stringify(stored), r = stored.object;
        this.db.prepare("INSERT OR IGNORE INTO resources VALUES (?,?,?,?,?,?,?,?,NULL)").run(key, scope, kindKey(r), r.metadata.uid, data, Buffer.byteLength(data), r.metadata.creationTimestamp, Date.now());
        this.indexLifecycle(key, scope, r);
      }
      this.db.prepare("INSERT INTO migrations VALUES (?)").run(id);
    });
  }
  private collect(kind: string, protectedKey: string): void {
    const limits = { ...this.config.defaults, ...this.config.kinds[kind] };
    const usage = () => this.db.prepare("SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM resources WHERE kind=?").get(kind)!;
    const total = () => Number(this.db.prepare("SELECT coalesce(sum(bytes),0) AS n FROM resources").get()!.n);
    const before = usage();
    const kindFull = Number(before.n) > limits.maxCount || Number(before.bytes) > limits.maxBytes;
    const totalFull = total() > this.config.maxBytes;
    if (!kindFull && !totalFull) return;
    const evict = (onlyKind: boolean, order: string, enough: () => boolean) => {
      const candidates = this.db.prepare(`SELECT key,scope,data FROM resources r WHERE released IS NOT NULL AND released<=? AND key<>?
        AND (?=0 OR kind=?) AND NOT EXISTS(SELECT 1 FROM resource_refs WHERE target=r.uid) ORDER BY ${order},key`);
      for (const row of candidates.iterate(new Date().toISOString(), protectedKey, onlyKind ? 1 : 0, kind)) {
        if (enough()) break;
        if (this.writtenKeys.has(row.key as string)) continue;
        this.remove(row.key as string);
        this.evicted.push({ scope: row.scope as string, resource: (JSON.parse(row.data as string) as StoredResource).object });
      }
    };
    if (kindFull) {
      const order = limits.order === "lru" ? "accessed" : limits.order === "created" ? "created" : "released";
      evict(true, order, () => {
        const u = usage();
        return Number(u.n) <= Math.ceil(limits.maxCount * this.config.lowWatermark) && Number(u.bytes) <= limits.maxBytes * this.config.lowWatermark;
      });
    }
    // Global pressure can be relieved by any eligible kind, after the triggering kind's own quota is satisfied.
    if (totalFull) evict(false, "released", () => total() <= this.config.maxBytes * this.config.lowWatermark);
    const after = usage();
    if (Number(after.n) > limits.maxCount || Number(after.bytes) > limits.maxBytes || total() > this.config.maxBytes) {
      throw new ResourceCapacityError(kind, `count ${after.n}/${limits.maxCount}, kind bytes ${after.bytes}/${limits.maxBytes}, host bytes ${total()}/${this.config.maxBytes}`);
    }
  }
  afterCommit(callback: () => void): void {
    if (this.inTransaction) this.afterCommitCallbacks.push(callback);
    else callback();
  }

  /** @spec Synchronous writes commit together; no observer sees a partially committed business result and Output. */
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
    this.writtenKeys.clear();
    let result: T;
    try {
      result = fn();
      if (result && typeof (result as { then?: unknown }).then === "function") throw new Error("Resource transaction must be synchronous");
      if (this.rollbackOnly) throw this.rollbackError;
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK"); this.evicted = []; this.afterCommitCallbacks = []; throw error;
    } finally { this.inTransaction = false; this.writtenKeys.clear(); }
    const callbacks = this.afterCommitCallbacks; this.afterCommitCallbacks = [];
    for (const callback of callbacks) { try { callback(); } catch { /* already committed */ } }
    const removed = this.evicted; this.evicted = [];
    for (const item of removed) for (const listener of this.listeners) { try { listener(item.scope, item.resource); } catch { /* committed; a subscriber cannot roll back deletion */ } }
    return result;
  }
}
export const resourceHome = (sessionDir: string): string => basename(dirname(sessionDir)) === "sessions" ? dirname(dirname(sessionDir)) : sessionDir;
