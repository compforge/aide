import { installPageIndex } from "./page-index.ts";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { ResourceContinueInvalid, ResourceExpired, type ResourcePageOptions, type ResourceType } from "@compforge/aide-plugin";

const api = "json_extract(r.data,'$.object.apiVersion')";
const kind = "json_extract(r.data,'$.object.kind')";
const ns = "json_extract(r.data,'$.object.metadata.namespace')";
const name = "json_extract(r.data,'$.object.metadata.name')";
interface Cursor { query: string; revision: number; after: string[]; until?: string[] }

/** @spec SQL selects at most limit+1 keys; only returned page objects are decoded by the Store.
 * @spec Consistent cursors expire on collection changes; live cursors persist an upper key bound and survive restart.
 * @why SQLite has no retained cross-request resource snapshots. Reject changed revisions instead of mixing pages.
 * @case tests/resource-pagination.test.ts
 * @link docs/plugin/resource.md#分页查询
 */
export class ResourcePages {
  private readonly secret = randomBytes(32);
  private readonly liveSecret: string;
  constructor(private readonly db: DatabaseSync) {
    installPageIndex(db);
    this.liveSecret = db.prepare("SELECT secret FROM resource_page_secrets WHERE id=1").get()!.secret as string;
    db.exec(`CREATE INDEX IF NOT EXISTS resource_page ON resources(scope,
      json_extract(data,'$.object.apiVersion'),json_extract(data,'$.object.kind'),
      json_extract(data,'$.object.metadata.namespace'),json_extract(data,'$.object.metadata.name'));
      CREATE TABLE IF NOT EXISTS resource_revisions (
        scope TEXT NOT NULL, api_version TEXT NOT NULL, kind TEXT NOT NULL, revision INTEGER NOT NULL,
        PRIMARY KEY(scope,api_version,kind));`);
    for (const [event, row, condition] of [
      ["INSERT", "NEW", ""], ["DELETE", "OLD", ""],
      ["UPDATE OF data", "NEW", "WHEN json_extract(OLD.data,'$.object') <> json_extract(NEW.data,'$.object')"],
    ] as const) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS resource_revision_${row}_${event.split(" ")[0]} AFTER ${event} ON resources ${condition} BEGIN
        INSERT INTO resource_revisions VALUES (${row}.scope,json_extract(${row}.data,'$.object.apiVersion'),json_extract(${row}.data,'$.object.kind'),1)
        ON CONFLICT(scope,api_version,kind) DO UPDATE SET revision=revision+1;
      END;`);
    }
  }
  invalidate(scope: string, type: ResourceType): void {
    this.db.prepare(`INSERT INTO resource_revisions VALUES (?,?,?,1)
      ON CONFLICT(scope,api_version,kind) DO UPDATE SET revision=revision+1`).run(scope, type.apiVersion, type.kind);
  }
  private sign(value: string, live = false): string { return createHmac("sha256", live ? this.liveSecret : this.secret).update(value).digest("base64url"); }
  private decode(token: string, live: boolean): Cursor {
    if (typeof token !== "string") throw new ResourceContinueInvalid("Invalid Resource continue token");
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) throw new ResourceContinueInvalid("Invalid Resource continue token");
    // Consistent tokens expire on restart; live bookmarks use a persisted signing key, never a retained snapshot.
    if (this.sign(payload, live) !== signature) throw new ResourceExpired("Resource continue token expired; restart the list");
    try {
      const cursor = JSON.parse(Buffer.from(payload, "base64url").toString()) as Cursor;
      if (typeof cursor.query !== "string" || !Number.isSafeInteger(cursor.revision) || !Array.isArray(cursor.after)
        || ![2, 3].includes(cursor.after.length) || cursor.after.some(v => typeof v !== "string")) throw new Error("Invalid cursor fields");
      if (live && (!Array.isArray(cursor.until) || cursor.until.length !== cursor.after.length || cursor.until.some(v => typeof v !== "string"))) throw new Error("Invalid upper bound");
      return cursor;
    } catch { throw new ResourceContinueInvalid("Invalid Resource continue token"); }
  }
  /** Called inside the same storage transaction that loads the selected objects. */
  list(scope: string, type: ResourceType, options: ResourcePageOptions, ordered = false) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000)
      throw new Error("Resource page limit must be an integer in 1..1000");
    if (options.includeDescendants !== undefined && typeof options.includeDescendants !== "boolean") throw new Error("Invalid includeDescendants");
    if (options.matchIndex && (typeof options.matchIndex.name !== "string" || typeof options.matchIndex.value !== "string")) throw new Error("Invalid resource index selector");
    if (options.consistency !== undefined && !["consistent", "live"].includes(options.consistency)) throw new ResourceContinueInvalid("Invalid consistency mode");
    if (options.direction !== undefined && !["asc", "desc"].includes(options.direction)) throw new Error("Invalid page direction");
    const descending = options.direction === "desc";
    const live = options.consistency === "live";
    const namespace = options.namespace ?? "v1";
    const labels = Object.entries(options.matchLabels ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const query = createHash("sha256").update(JSON.stringify([scope, type.apiVersion, type.kind, namespace,
      !!options.includeDescendants, options.matchIndex ? [options.matchIndex.name, options.matchIndex.value] : null, labels, live, ordered, descending])).digest("hex");
    const revision = Number(this.db.prepare("SELECT revision FROM resource_revisions WHERE scope=? AND api_version=? AND kind=?")
      .get(scope, type.apiVersion, type.kind)?.revision ?? 0);
    const cursor = options.continue === undefined || options.continue === "" ? undefined : this.decode(options.continue, live);
    if (cursor && cursor.query !== query) throw new ResourceContinueInvalid("Resource continue token belongs to a different query");
    if (!live && cursor && cursor.revision !== revision) throw new ResourceExpired("Resource collection changed; restart the list");
    const indexed = !!options.matchIndex;
    const namespaceColumn = indexed ? "p.namespace" : ns, nameColumn = indexed ? "p.resource_name" : name;
    const keyColumn = indexed ? "p.source" : "r.key";
    let from = ordered ? "resource_ordered_indexes p INDEXED BY resource_ordered_lookup"
      : indexed ? "resource_page_indexes p INDEXED BY resource_page_lookup" : "resources r INDEXED BY resource_page";
    if (indexed && labels.length) from += " JOIN resources r ON r.key=p.source";
    const values: SQLInputValue[] = [scope, type.apiVersion, type.kind];
    const where = indexed ? ["p.scope=?", "p.api_version=?", "p.kind=?"] : ["r.scope=?", `${api}=?`, `${kind}=?`];
    if (options.matchIndex) { where.push("p.index_name=? AND p.index_value=?"); values.push(options.matchIndex.name, options.matchIndex.value); }
    if (options.includeDescendants) {
      where.push(`(${namespaceColumn}=? OR (${namespaceColumn}>=? AND ${namespaceColumn}<?))`);
      values.push(namespace, namespace + "/", namespace + "0");
    } else { where.push(`${namespaceColumn}=?`); values.push(namespace); }
    for (const [key, value] of labels) {
      where.push("EXISTS (SELECT 1 FROM json_each(r.data,'$.object.metadata.labels') label WHERE label.key=? AND label.value=? AND label.type='text')");
      values.push(key, value);
    }
    const columns = [namespaceColumn, ...(ordered ? ["p.order_key"] : []), nameColumn];
    const fields = columns.map((column, i) => `${column} AS k${i}`).join(",");
    const order = (desc: boolean) => columns.map(column => `${column} COLLATE BINARY ${desc ? "DESC" : "ASC"}`).join(",");
    const tuple = `(${columns.join(",")})`, placeholders = `(${columns.map(() => "?").join(",")})`;
    const rowKey = (row: Record<string, unknown>) => columns.map((_, i) => row[`k${i}`] as string);
    let until = cursor?.until;
    if (live && !cursor) {
      const last = this.db.prepare(`SELECT ${fields} FROM ${from}
        WHERE ${where.join(" AND ")} ORDER BY ${order(!descending)} LIMIT 1`).get(...values);
      if (last) until = rowKey(last);
    }
    if (cursor) { where.push(`${tuple}${descending ? "<" : ">"}${placeholders}`); values.push(...cursor.after); }
    if (until) { where.push(`${tuple}${descending ? ">=" : "<="}${placeholders}`); values.push(...until); }
    values.push(options.limit + 1);
    const rows = this.db.prepare(`SELECT ${keyColumn} AS key,${fields} FROM ${from}
      WHERE ${where.join(" AND ")} ORDER BY ${order(descending)} LIMIT ?`).all(...values);
    const page = rows.slice(0, options.limit);
    let token = "";
    if (rows.length > options.limit) {
      const last = page.at(-1)!;
      const payload = Buffer.from(JSON.stringify({ query, revision, after: rowKey(last), ...(until ? { until } : {}) } satisfies Cursor)).toString("base64url");
      token = `${payload}.${this.sign(payload, live)}`;
    }
    return { keys: page.map(row => row.key as string), metadata: { resourceVersion: String(revision), continue: token } };
  }
}
