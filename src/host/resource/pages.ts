import { createHash, createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { ResourceContinueInvalid, ResourceExpired, type ResourcePageOptions, type ResourceType } from "@compforge/aide-plugin";

const api = "json_extract(r.data,'$.object.apiVersion')";
const kind = "json_extract(r.data,'$.object.kind')";
const ns = "json_extract(r.data,'$.object.metadata.namespace')";
const name = "json_extract(r.data,'$.object.metadata.name')";
interface Cursor { query: string; revision: number; after: [string, string] }

/** @spec SQL selects at most limit+1 keys; only returned page objects are decoded by the Store.
 * @spec Collection changes expire cursors, including deletion/eviction; control-only and LRU writes do not.
 * @why SQLite has no retained cross-request resource snapshots. Reject changed revisions instead of mixing pages.
 * @case tests/resource-pagination.test.ts
 * @link docs/plugin/resource.md#分页查询
 */
export class ResourcePages {
  private readonly secret = randomBytes(32);
  constructor(private readonly db: DatabaseSync) {
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
  private sign(value: string): string { return createHmac("sha256", this.secret).update(value).digest("base64url"); }
  private decode(token: string): Cursor {
    if (typeof token !== "string") throw new ResourceContinueInvalid("Invalid Resource continue token");
    const [payload, signature, extra] = token.split(".");
    if (!payload || !signature || extra !== undefined) throw new ResourceContinueInvalid("Invalid Resource continue token");
    // Tokens deliberately expire when the Host restarts; no historical snapshots or token state are retained.
    if (this.sign(payload) !== signature) throw new ResourceExpired("Resource continue token expired; restart the list");
    try {
      const cursor = JSON.parse(Buffer.from(payload, "base64url").toString()) as Cursor;
      if (typeof cursor.query !== "string" || !Number.isSafeInteger(cursor.revision) || !Array.isArray(cursor.after)
        || cursor.after.length !== 2 || cursor.after.some(v => typeof v !== "string")) throw new Error("Invalid cursor fields");
      return cursor;
    } catch { throw new ResourceContinueInvalid("Invalid Resource continue token"); }
  }
  /** Called inside the same storage transaction that loads the selected objects. */
  list(scope: string, type: ResourceType, options: ResourcePageOptions) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 1000)
      throw new Error("Resource page limit must be an integer in 1..1000");
    if (options.includeDescendants !== undefined && typeof options.includeDescendants !== "boolean") throw new Error("Invalid includeDescendants");
    if (options.matchIndex && (typeof options.matchIndex.name !== "string" || typeof options.matchIndex.value !== "string")) throw new Error("Invalid resource index selector");
    const namespace = options.namespace ?? "v1";
    const labels = Object.entries(options.matchLabels ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const query = createHash("sha256").update(JSON.stringify([scope, type.apiVersion, type.kind, namespace,
      !!options.includeDescendants, options.matchIndex ? [options.matchIndex.name, options.matchIndex.value] : null, labels])).digest("hex");
    const revision = Number(this.db.prepare("SELECT revision FROM resource_revisions WHERE scope=? AND api_version=? AND kind=?")
      .get(scope, type.apiVersion, type.kind)?.revision ?? 0);
    const cursor = options.continue === undefined || options.continue === "" ? undefined : this.decode(options.continue);
    if (cursor && cursor.query !== query) throw new ResourceContinueInvalid("Resource continue token belongs to a different query");
    if (cursor && cursor.revision !== revision) throw new ResourceExpired("Resource collection changed; restart the list");
    const values: SQLInputValue[] = [scope, type.apiVersion, type.kind];
    const where = [`r.scope=?`, `${api}=?`, `${kind}=?`];
    if (options.includeDescendants) {
      // The '/' boundary excludes sibling namespaces with a common textual prefix.
      where.push(`(${ns}=? OR (${ns}>=? AND ${ns}<?))`);
      values.push(namespace, namespace + "/", namespace + "0");
    } else { where.push(`${ns}=?`); values.push(namespace); }
    if (cursor) { where.push(`(${ns},${name})>(?,?)`); values.push(...cursor.after); }
    for (const [key, value] of labels) {
      where.push("EXISTS (SELECT 1 FROM json_each(r.data,'$.object.metadata.labels') label WHERE label.key=? AND label.value=? AND label.type='text')");
      values.push(key, value);
    }
    let from = "resources r INDEXED BY resource_page";
    if (options.matchIndex) {
      // Start at the selective secondary index; never decode unrelated resource bodies in JavaScript.
      from = "resource_indexes i INDEXED BY resource_index_lookup CROSS JOIN resources r INDEXED BY resource_scope";
      where.push("i.name=? AND i.value=? AND r.key=i.source");
      values.push(options.matchIndex.name, options.matchIndex.value);
    }
    values.push(options.limit + 1);
    const rows = this.db.prepare(`SELECT r.key,${ns} AS namespace,${name} AS name FROM ${from}
      WHERE ${where.join(" AND ")} ORDER BY ${ns} COLLATE BINARY,${name} COLLATE BINARY LIMIT ?`).all(...values);
    const page = rows.slice(0, options.limit);
    let token = "";
    if (rows.length > options.limit) {
      const last = page.at(-1)!;
      const payload = Buffer.from(JSON.stringify({ query, revision, after: [last.namespace as string, last.name as string] } satisfies Cursor)).toString("base64url");
      token = `${payload}.${this.sign(payload)}`;
    }
    return { keys: page.map(row => row.key as string), metadata: { resourceVersion: String(revision), continue: token } };
  }
}
