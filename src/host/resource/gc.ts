import { setImmediate as yieldToHost } from "node:timers/promises";
import type { Resource } from "@compforge/aide-plugin";
import { logError, type LogSink } from "../logging.ts";
import { ResourceStorage } from "./storage.ts";

type ObjectResource = Resource<unknown, unknown>;
type Lifecycle = "controller" | "unmanaged" | "unavailable";
interface Candidate { key: string; position: string | number }
type PressureTier = "low" | "high" | "full";
const tiers: PressureTier[] = ["low", "high", "full"];
interface Usage { count: number; bytes: number; pendingCount: number; pendingBytes: number }

/** @spec GC first expires due objects, then applies low/high/full pressure tiers explicitly declared by each owner.
 * Admission and GC commit independently; deleting resources count until actually finalized.
 * @why Timers alone do not isolate synchronous SQLite work: candidate pages and tree transactions are bounded.
 * @link docs/plugin/resource.md#gc
 * @case tests/resource-gc.test.ts
 */
export class ResourceGarbageCollector {
  private timer?: ReturnType<typeof setInterval>;
  private wakeup?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private closed = false;
  private requested = false;
  private unsubscribe?: () => void;
  private unsubscribeWrites?: () => void;
  constructor(private readonly storage: ResourceStorage, private readonly options: {
    lifecycle(scope: string, resource: ObjectResource): Lifecycle;
    log?: LogSink;
  }) {}

  start(): void {
    if (this.timer || this.closed) return;
    this.unsubscribe = this.storage.subscribePressure(() => this.wake());
    this.unsubscribeWrites = this.storage.subscribeWrites((_scope, resource, previous) => {
      if (resource.metadata.deletionTimestamp && !previous?.metadata.deletionTimestamp) this.wake();
    });
    this.timer = setInterval(() => this.wake(), this.storage.configuration.gc.intervalMs);
    this.timer.unref();
    this.wake();
  }
  private wake(): void {
    if (this.closed || this.wakeup) return;
    if (this.running) { this.requested = true; return; }
    this.wakeup = setTimeout(() => {
      this.wakeup = undefined;
      void this.run().catch(error => this.reportError(error));
    }, 0);
    this.wakeup.unref();
  }
  /** Also usable for a deterministic one-shot maintenance pass. Concurrent callers join it. */
  run(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.running) return this.running;
    clearTimeout(this.wakeup); this.wakeup = undefined;
    // @why Register the pass before synchronous writes can notify listeners and request another pass.
    const running = Promise.resolve().then(() => this.collect()).finally(() => {
      this.running = undefined;
      if (this.requested) { this.requested = false; this.wake(); }
    });
    this.running = running;
    return running;
  }
  async close(): Promise<void> {
    this.closed = true;
    clearInterval(this.timer); clearTimeout(this.wakeup); this.unsubscribe?.(); this.unsubscribeWrites?.();
    await this.running;
  }
  private reportError(error: unknown, key?: string): void {
    this.options.log?.({ level: "error", source: "aide", component: "resource.gc", message: "Resource collection failed; will retry on next pass",
      error: logError(error), attributes: { ...(key ? { key } : {}) } });
  }
  private usage(kind: string): Usage {
    const args = kind === "*" ? [] : [kind];
    const row = this.storage.db.prepare(`SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes
      FROM resources ${kind === "*" ? "" : "WHERE kind=?"}`).get(...args)!;
    const pending = this.storage.db.prepare(`SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes
      FROM resources INDEXED BY resource_gc_deleting WHERE json_extract(data,'$.object.metadata.deletionTimestamp')>''
      ${kind === "*" ? "" : "AND kind=?"}`).get(...args)!;
    return { count: Number(row.n), bytes: Number(row.bytes), pendingCount: Number(pending.n), pendingBytes: Number(pending.bytes) };
  }

  private satisfied(kind: string, projected: boolean, tier: PressureTier = "low"): boolean {
    const config = this.storage.configuration, usage = this.usage(kind);
    const limits = { ...config.defaults, ...config.kinds[kind] };
    // Project pending deletion only to avoid scheduling excess eviction, never for write admission.
    const count = usage.count - (projected ? usage.pendingCount : 0);
    const bytes = usage.bytes - (projected ? usage.pendingBytes : 0);
    const watermark = tier === "full" ? 1 : tier === "high" ? config.highWatermark : config.lowWatermark;
    return (kind === "*" || count < limits.maxCount * watermark)
      && bytes < (kind === "*" ? config.maxBytes : limits.maxBytes) * watermark;
  }
  private detectPressure(): void {
    const config = this.storage.configuration;
    const rows = this.storage.db.prepare("SELECT kind,count(*) AS n,sum(bytes) AS bytes FROM resources GROUP BY kind").all();
    let total = 0;
    for (const row of rows) {
      const kind = String(row.kind), limits = { ...config.defaults, ...config.kinds[kind] };
      total += Number(row.bytes);
      if (Number(row.n) >= limits.maxCount * config.lowWatermark || Number(row.bytes) >= limits.maxBytes * config.lowWatermark) this.storage.capacityPressure.add(kind);
    }
    if (total >= config.maxBytes * config.lowWatermark) this.storage.capacityPressure.add("*");
  }
  private candidates(kind: string, after?: Candidate): Candidate[] {
    const config = this.storage.configuration, limits = { ...config.defaults, ...config.kinds[kind] };
    const order = kind === "*" ? "released" : limits.order === "lru" ? "accessed" : limits.order;
    // Find relevant roots by walking UP from released members of the saturated kind.
    // No released member means no candidate trees, regardless of unrelated database contents.
    const ancestors = kind === "*" ? "" : `WITH RECURSIVE ancestors(key,uid,owner) AS (
      SELECT key,uid,json_extract(data,'$.object.metadata.owner.uid') FROM resources WHERE kind=? AND released<=?
      UNION SELECT p.key,p.uid,json_extract(p.data,'$.object.metadata.owner.uid') FROM resources p JOIN ancestors a ON p.uid=a.owner
    ) `;
    const now = new Date().toISOString();
    const rows = this.storage.db.prepare(`${ancestors}SELECT r.key,r.${order} AS position FROM resources r
      WHERE r.released<=? AND NOT EXISTS(SELECT 1 FROM resources p WHERE p.uid=json_extract(r.data,'$.object.metadata.owner.uid'))
      ${kind === "*" ? "" : "AND r.key IN (SELECT key FROM ancestors)"}
      ${after ? `AND (r.${order}>? OR (r.${order}=? AND r.key>?))` : ""}
      ORDER BY r.${order},r.key LIMIT ?`).all(...[
        ...(kind === "*" ? [] : [kind, now]), now,
        ...(after ? [after.position, after.position, after.key] : []), config.gc.batchSize,
      ]);
    return rows.map(row => ({ key: String(row.key), position: row.position as string | number }));
  }
  private pressureCandidates(kind: string, tier: PressureTier, after?: Candidate): Candidate[] {
    const rows = this.storage.db.prepare(`SELECT source AS key,position FROM resource_pressure
      WHERE tier=? ${kind === "*" ? "" : "AND kind=?"}
      ${after ? "AND (position>? OR (position=? AND source>?))" : ""}
      ORDER BY position,source LIMIT ?`).all(tier, ...(kind === "*" ? [] : [kind]),
        ...(after ? [after.position, after.position, after.key] : []), this.storage.configuration.gc.batchSize);
    return rows.map(row => ({ key: String(row.key), position: String(row.position) }));
  }
  private requestTree(key: string, reason: "released" | "expiry" | PressureTier = "released"): number {
    return this.storage.transaction(() => {
      if (!this.storage.ready) return 0;
      const rows = this.storage.db.prepare(`WITH RECURSIVE owned(key,uid,scope,data,released) AS (
        SELECT key,uid,scope,data,released FROM resources WHERE key=?
        UNION ALL SELECT c.key,c.uid,c.scope,c.data,c.released FROM resources c JOIN owned p
          ON json_extract(c.data,'$.object.metadata.owner.uid')=p.uid LIMIT ?
      ) SELECT * FROM owned`).all(key, this.storage.configuration.gc.maxTreeSize + 1);
      if (rows.length > this.storage.configuration.gc.maxTreeSize) {
        this.options.log?.({ level: "warn", source: "aide", component: "resource.gc", message: "Ownership tree exceeds collection transaction limit; preserved",
          attributes: { key, maxTreeSize: this.storage.configuration.gc.maxTreeSize } });
        return 0;
      }
      const keys = new Set(rows.map(row => String(row.key)));
      const members: string[] = [];
      for (const row of rows) {
        const scope = String(row.scope), resource = this.storage.decode(scope, String(row.data)).object;
        if (this.options.lifecycle(scope, resource) === "unavailable" || !this.storage.canCollect(scope, resource)) return 0;
        const expired = this.storage.expired(scope, resource);
        const pressure = this.storage.pressureTier(scope, resource);
        const discard = tiers.includes(reason as PressureTier) && pressure && tiers.indexOf(pressure) <= tiers.indexOf(reason as PressureTier);
        if (!discard && (!row.released || String(row.released) > new Date().toISOString())) return 0;
        if (String(row.key) === key && reason === "expiry" && !expired && !this.storage.collectOnRelease(scope, resource)) return 0;
        if (!expired && !discard) for (const reference of this.storage.db.prepare("SELECT source FROM resource_refs WHERE target=?").iterate(String(row.uid))) {
          if (!keys.has(String(reference.source))) return 0;
        }
        members.push(String(row.key));
      }
      // Eligibility and all deletion marks share a transaction: no partially admitted ownership tree.
      for (const member of members) this.storage.requestDeletion(member);
      if (members.length) this.storage.afterCommit(() => this.options.log?.({ level: "info", source: "aide", component: "resource.gc",
        message: "Resource collection requested", attributes: { key, reason, count: members.length } }));
      return members.length;
    });
  }
  /** Ownership deletion is independent of retention: the owner's deletion already decided the lifecycle. */
  private async propagateDeletion(): Promise<number> {
    let after = "", requested = 0;
    while (!this.closed) {
      const rows = this.storage.db.prepare(`SELECT c.key,c.scope,c.data FROM resources c INDEXED BY resource_owner
        LEFT JOIN resources p ON p.uid=json_extract(c.data,'$.object.metadata.owner.uid')
        WHERE json_extract(c.data,'$.object.metadata.owner.uid')>'' AND c.key>?
        AND json_extract(c.data,'$.object.metadata.deletionTimestamp') IS NULL
        AND (p.uid IS NULL OR json_extract(p.data,'$.object.metadata.deletionTimestamp') IS NOT NULL)
        ORDER BY c.key LIMIT ?`).all(after, this.storage.configuration.gc.batchSize);
      if (!rows.length) break;
      for (const row of rows) {
        if (this.closed) break;
        after = String(row.key);
        try {
          const scope = String(row.scope), resource = this.storage.decode(scope, String(row.data)).object;
          if (this.options.lifecycle(scope, resource) !== "unavailable") {
            this.storage.requestDeletion(after); requested++;
          }
        } catch (error) { this.reportError(error, after); }
      }
      await yieldToHost();
    }
    return requested;
  }
  private async finalizeUnmanaged(): Promise<number> {
    let after = "", removed = 0;
    while (!this.closed) {
      const rows = this.storage.db.prepare(`SELECT key,scope,data FROM resources
        WHERE json_extract(data,'$.object.metadata.deletionTimestamp')>'' AND key>? ORDER BY key LIMIT ?`)
        .all(after, this.storage.configuration.gc.batchSize);
      if (!rows.length) break;
      for (const row of rows) {
        if (this.closed) break;
        after = String(row.key);
        try {
          const scope = String(row.scope), resource = this.storage.decode(scope, String(row.data)).object;
          if (this.options.lifecycle(scope, resource) === "unmanaged") { this.storage.collectFinalized(after); removed++; }
        } catch (error) { this.reportError(error, after); }
      }
      await yieldToHost();
    }
    return removed;
  }
  private async collect(): Promise<void> {
    if (!this.storage.ready) return;
    const started = performance.now();
    let requested = await this.propagateDeletion(), checked = 0, removed = await this.finalizeUnmanaged();
    // Expiry is opt-in per definition. Use the existing release index and the same transactional guards as capacity GC.
    for (const { scope, kind } of this.storage.expiringCollections()) {
      let after: Candidate | undefined;
      const now = new Date().toISOString();
      while (!this.closed) {
        const rows = this.storage.db.prepare(`SELECT key,released AS position FROM resources
          WHERE scope=? AND kind=? AND released<=?
          ${after ? "AND (released>? OR (released=? AND key>?))" : ""}
          ORDER BY released,key LIMIT ?`).all(scope, kind, now,
            ...(after ? [after.position, after.position, after.key] : []), this.storage.configuration.gc.batchSize);
        if (!rows.length) break;
        for (const row of rows) {
          if (this.closed) break;
          after = { key: String(row.key), position: String(row.position) }; checked++;
          try { requested += this.requestTree(after.key, "expiry"); }
          catch (error) { this.reportError(error, after.key); }
          await yieldToHost();
        }
      }
    }
    this.detectPressure();
    for (const kind of this.storage.capacityPressure) {
      if (this.closed) break;
      let after: Candidate | undefined;
      while (!this.closed && !this.satisfied(kind, true)) {
        const candidates = this.candidates(kind, after);
        if (!candidates.length) break;
        for (const candidate of candidates) {
          if (this.closed || this.satisfied(kind, true)) break;
          after = candidate; checked++;
          try { requested += this.requestTree(candidate.key); }
          catch (error) { this.reportError(error, candidate.key); }
          await yieldToHost();
        }
      }
      // Each tier has its own watermark. Exhausting eligible completed records does not make failures eligible below the high watermark.
      for (const tier of tiers) {
        after = undefined;
        while (!this.closed && !this.satisfied(kind, true, tier)) {
          const candidates = this.pressureCandidates(kind, tier, after);
          if (!candidates.length) break;
          for (const candidate of candidates) {
            if (this.closed || this.satisfied(kind, true, tier)) break;
            after = candidate; checked++;
            try { requested += this.requestTree(candidate.key, tier); }
            catch (error) { this.reportError(error, candidate.key); }
            await yieldToHost();
          }
        }
      }
      if (this.satisfied(kind, false)) this.storage.capacityPressure.delete(kind);
    }
    removed += await this.finalizeUnmanaged();
    for (const kind of this.storage.capacityPressure) if (this.satisfied(kind, false)) this.storage.capacityPressure.delete(kind);
    if (checked || requested || removed || this.storage.capacityPressure.size) this.options.log?.({ level: "info", source: "aide", component: "resource.gc",
      message: "Resource collection pass completed", attributes: { checked, requested, removed,
        pressure: [...this.storage.capacityPressure], durationMs: Math.round(performance.now() - started) } });
  }
}
