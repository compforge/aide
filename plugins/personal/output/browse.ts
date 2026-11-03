import { mailView } from "../stream/writer.ts";
import { OUTPUT_TYPE, type Output, type OutputStatus } from "./model.ts";
import type { OutputStore } from "./store.ts";
import { pageBounds, pageSize, type PageQuery } from "../browse.ts";

export interface OutputBrowseQuery extends PageQuery {
  q?: string; topicUid?: string; receiverUid?: string; addressUid?: string;
  phase?: OutputStatus["phase"]; disclosure?: "pending" | "allowed" | "denied";
  from?: string; to?: string;
}
const field = (path: string) => `json_extract(data, '$.object.${path}')`;
const scope = `scope = 'personal' AND kind = 'aide.dev/Output' AND ${field("apiVersion")} = '${OUTPUT_TYPE.apiVersion}'
  AND ${field("metadata.namespace")} = 'v1' AND ${field("metadata.deletionTimestamp")} IS NULL`;

/**
 * @spec Filter retained Outputs before paging; intent and actual recipients/addresses both match. Reading never refreshes retention access times.
 * @link docs/personal/output.md#web-查询
 * @case tests/output-browse.test.ts
 */
export function browseOutputs(store: OutputStore, query: OutputBrowseQuery = {}) {
  const size = pageSize(query), clauses = [scope], args: (string | number)[] = [];
  for (const [expression, value] of [[field("spec.topic.uid"), query.topicUid], [field("status.phase"), query.phase],
    [`coalesce(${field("status.disclosure.decision")}, 'pending')`, query.disclosure]] as const)
    if (value !== undefined) { clauses.push(`${expression} = ?`); args.push(value); }
  if (query.addressUid) {
    clauses.push(`(${field("spec.target.uid")} = ? OR ${field("status.delivery.address.uid")} = ?)`);
    args.push(query.addressUid, query.addressUid);
  }
  if (query.receiverUid) {
    clauses.push(`(EXISTS (SELECT 1 FROM json_each(data, '$.object.spec.receivers') WHERE json_extract(value, '$.uid') = ?)
      OR EXISTS (SELECT 1 FROM json_each(data, '$.object.status.delivery.receivers') WHERE json_extract(value, '$.uid') = ?))`);
    args.push(query.receiverUid, query.receiverUid);
  }
  for (const [operator, value] of [[">=", query.from], ["<=", query.to]] as const)
    if (value) { clauses.push(`created ${operator} ?`); args.push(value); }
  const where = clauses.join(" AND ");
  return store.storage.transaction(() => {
    if (query.q) {
      const term = query.q.toLowerCase();
      const matches: Output[] = [];
      for (const row of store.storage.db.prepare(`SELECT data FROM resources WHERE ${where} ORDER BY created DESC, key DESC`).iterate(...args)) {
        const item = store.storage.decode("personal", row.data as string).object as Output;
        const raw = mailView(store, item), actual = item.status.delivery?.stream.uid === item.spec.stream.uid ? raw : mailView(store, item, true);
        if ([item.metadata.name, raw.text, raw.think, actual.text, actual.think].some(text => text.toLowerCase().includes(term))) matches.push(item);
      }
      const bounds = pageBounds(matches.length, size, query.page);
      return { ...bounds, items: matches.slice((bounds.page - 1) * size, bounds.page * size) };
    }
    const total = Number(store.storage.db.prepare(`SELECT count(*) AS count FROM resources WHERE ${where}`).get(...args)!.count);
    const bounds = pageBounds(total, size, query.page);
    const rows = store.storage.db.prepare(`SELECT data FROM resources WHERE ${where} ORDER BY created DESC, key DESC LIMIT ? OFFSET ?`)
      .all(...args, size, (bounds.page - 1) * size);
    return { ...bounds, items: rows.map(row => store.storage.decode("personal", row.data as string).object as Output) };
  });
}

/** Facets use retained references, including recipients/destinations changed by disclosure checks. */
export function outputFacets(store: OutputStore) {
  const refs = (paths: string[]) => store.storage.db.prepare(paths.map(path => path.endsWith('receivers')
    ? `SELECT DISTINCT value AS ref FROM resources, json_each(data, '$.object.${path}') WHERE ${scope}`
    : `SELECT DISTINCT ${field(path)} AS ref FROM resources WHERE ${scope} AND ${field(path)} IS NOT NULL`).join(' UNION '))
    .all().map(row => JSON.parse(row.ref as string) as import("@compforge/aide-plugin").ResourceRef);
  return { topics: refs(["spec.topic"]), receivers: refs(["spec.receivers", "status.delivery.receivers"]), addresses: refs(["spec.target", "status.delivery.address"]) };
}
