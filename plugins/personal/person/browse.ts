import type { ResourceStorage } from "../../../src/host/resource/storage.ts";
import type { Me } from "./model.ts";
import { pageBounds, pageSize, type PageQuery } from "../browse.ts";

export interface PersonBrowseQuery extends PageQuery { q?: string; name?: string; excludeUid?: string; selectedId?: string }
export interface PersonListItem { id: string; uid: string; version: string; name: string; isMe: boolean; preview: string; updatedAt: string }
const field = (path: string) => `json_extract(data, '$.object.${path}')`;
const columns = `${field("metadata.name")} AS id, uid, ${field("metadata.resourceVersion")} AS version,
  ${field("spec.name")} AS name, substr(trim(${field("status.summary")}), 1, 80) AS preview, ${field("status.updatedAt")} AS updatedAt,
  length(trim(${field("status.summary")}, char(9,10,11,12,13,32))) > 0 AS known`;
const order = "known DESC, id ASC, uid ASC";

/**
 * @spec Search and understanding-first ordering precede SQL paging. Only configured identities establish pinned Me entries.
 * @spec Pinned entries do not consume the page quota or total; lists never load full profiles or touch retention times.
 * @link docs/channel/web.md#人物导航与编辑
 */
export function browsePersons(storage: ResourceStorage, marks: Me, query: PersonBrowseQuery = {}) {
  const size = pageSize(query), clauses = ["1=1"], args: string[] = [JSON.stringify(marks.identities)];
  if (query.q) { clauses.push("instr(lower(name), lower(?)) > 0"); args.push(query.q); }
  if (query.name !== undefined) { clauses.push("name = ?"); args.push(query.name); }
  if (query.excludeUid) { clauses.push("uid <> ?"); args.push(query.excludeUid); }
  const people = `WITH people AS (SELECT ${columns}, EXISTS (
    SELECT 1 FROM json_each(data, '$.object.spec.identities') identity JOIN json_each(?) mark
      ON json_extract(identity.value, '$.provider') = json_extract(mark.value, '$.provider')
      AND json_extract(identity.value, '$.scope') = json_extract(mark.value, '$.scope')
      AND json_extract(identity.value, '$.id') = json_extract(mark.value, '$.id')) AS isMe
    FROM resources WHERE scope = 'personal' AND kind = 'aide.dev/Person'
      AND ${field("metadata.namespace")} = 'v1' AND ${field("metadata.deletionTimestamp")} IS NULL),
    matches AS (SELECT * FROM people WHERE ${clauses.join(" AND ")})`;
  const map = (row: Record<string, unknown>): PersonListItem => ({ id: row.id as string, uid: row.uid as string, version: row.version as string,
    name: row.name as string, isMe: Boolean(row.isMe), preview: (row.preview as string).trim(), updatedAt: row.updatedAt as string });
  return storage.transaction(() => {
    const total = Number(storage.db.prepare(`${people} SELECT count(*) AS n FROM matches WHERE NOT isMe`).get(...args)!.n);
    let requested = query.page;
    if (requested === undefined && query.selectedId) {
      const position = storage.db.prepare(`${people} SELECT position FROM
        (SELECT id, row_number() OVER (ORDER BY ${order}) AS position FROM matches WHERE NOT isMe) WHERE id = ?`).get(...args, query.selectedId);
      if (position) requested = Math.ceil(Number(position.position) / size);
    }
    const bounds = pageBounds(total, size, requested);
    const rows = storage.db.prepare(`${people} SELECT * FROM matches WHERE NOT isMe ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, size, (bounds.page - 1) * size);
    const pinned = storage.db.prepare(`${people} SELECT * FROM matches WHERE isMe ORDER BY id, uid`).all(...args).map(map);
    return { ...bounds, items: rows.map(map), pinned };
  });
}
