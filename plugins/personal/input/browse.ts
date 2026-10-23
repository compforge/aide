import type { InputSpec, InputStatus } from "./model.ts";
import type { Resource } from "@compforge/aide-plugin";
import type { InputStore } from "./store.ts";

export interface InputBrowseQuery {
  page?: number; pageSize?: number; q?: string;
  origin?: InputSpec["origin"]; originId?: string; connector?: string; sourceUid?: string;
  state?: "pending" | "completed"; errors?: boolean;
}
export interface InputFacet { origin: InputSpec["origin"]; originId: string; connector: string; sourceUid: string; sourceName: string; sourceKind: string }

// Derive connector identity from retained, producer-stamped facts, including deleted Source resources.
const field = (path: string) => `json_extract(data, '$.object.${path}')`;
const connector = `CASE
  WHEN ${field("spec.source.kind")} = 'requirement' THEN 'requirements:' || ${field("spec.source.source")}
  WHEN ${field("spec.source.channelId")} = 'lark' OR (${field("spec.origin")} = 'channel' AND ${field("spec.originId")} = 'lark')
    OR ${field("spec.originId")} = 'personal.lark' THEN 'lark'
  WHEN ${field("spec.originId")} = 'personal.environments' AND json_type(data, '$.object.spec.observation.environment') = 'text'
    THEN 'environments:' || ${field("spec.observation.environment")}
  ELSE '' END`;
const unfinished = (stage: string) => `EXISTS (SELECT 1 FROM json_each(data, '$.object.status.${stage}') WHERE json_extract(value, '$.completedAt') IS NULL)`;
const completed = `(${field("status.route.completedAt")} IS NOT NULL AND NOT ${unfinished("assess")} AND NOT ${unfinished("handle")})`;
const errors = `(${field("status.route.lastError")} IS NOT NULL OR EXISTS
  (SELECT 1 FROM json_each(data, '$.object.status.assess') WHERE json_extract(value, '$.lastError') IS NOT NULL) OR EXISTS
  (SELECT 1 FROM json_each(data, '$.object.status.handle') WHERE json_extract(value, '$.lastError') IS NOT NULL))`;
const scope = `scope = 'personal' AND kind = 'aide.dev/Input' AND ${field("metadata.namespace")} = 'v1' AND ${field("metadata.deletionTimestamp")} IS NULL`;

/**
 * @spec Filter before paging, newest first with a stable key tie-breaker. Browsing does not refresh retention access times.
 * @spec Processing completion requires route and every assigned consumer receipt; it never implies a reply or Work completion.
 * @link docs/personal/input.md
 */
export function browseInputs(store: InputStore, query: InputBrowseQuery = {}) {
  const pageSize = query.pageSize ?? 20, requested = query.page ?? 1;
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isSafeInteger(requested) || requested < 1) throw new Error("Invalid Input page");
  const clauses = [scope], args: (string | number)[] = [];
  for (const [expression, value] of [
    [field("spec.origin"), query.origin], [field("spec.originId"), query.originId],
    [connector, query.connector], [field("spec.originRef.uid"), query.sourceUid],
  ] as const) if (value !== undefined) { clauses.push(`${expression} = ?`); args.push(value); }
  if (query.state) clauses.push(query.state === "completed" ? completed : `NOT ${completed}`);
  if (query.errors) clauses.push(errors);
  if (query.q) {
    clauses.push(`(instr(lower(${field("spec.text")}), lower(?)) > 0 OR instr(lower(${field("metadata.name")}), lower(?)) > 0)`);
    args.push(query.q, query.q);
  }
  const where = clauses.join(" AND ");
  return store.storage.transaction(() => {
    const total = Number(store.storage.db.prepare(`SELECT count(*) AS count FROM resources WHERE ${where}`).get(...args)!.count);
    const pages = Math.max(1, Math.ceil(total / pageSize)), page = Math.min(requested, pages);
    const rows = store.storage.db.prepare(`SELECT data, ${connector} AS connector, ${completed} AS completed, ${errors} AS errors
      FROM resources WHERE ${where} ORDER BY created DESC, key DESC LIMIT ? OFFSET ?`).all(...args, pageSize, (page - 1) * pageSize);
    return { page, pageSize, pages, total, items: rows.map(row => ({
      input: JSON.parse(row.data as string).object as Resource<InputSpec, InputStatus>,
      connector: row.connector as string, state: row.completed ? "completed" as const : "pending" as const, errors: Boolean(row.errors),
    })) };
  });
}

/** Facets describe all retained inputs, independently of the selected page or current Connector configuration. */
export function inputFacets(store: InputStore): InputFacet[] {
  return store.storage.db.prepare(`SELECT DISTINCT ${field("spec.origin")} AS origin, ${field("spec.originId")} AS originId,
    ${connector} AS connector, coalesce(${field("spec.originRef.uid")}, '') AS sourceUid,
    coalesce(${field("spec.originRef.name")}, '') AS sourceName, coalesce(${field("spec.originRef.kind")}, '') AS sourceKind
    FROM resources WHERE ${scope} ORDER BY origin, originId, connector, sourceKind, sourceName, sourceUid`).all() as unknown as InputFacet[];
}
