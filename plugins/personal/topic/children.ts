import { digest } from "../chief-model.ts";
import { pageBounds, pageSize, type PageQuery } from "../browse.ts";
import { TOPIC_TYPE } from "./model.ts";
import type { TopicStore } from "./store.ts";

export interface TopicChild { id: string; uid: string; name: string; hasChildren: boolean }

const field = (alias: string, path: string) => `json_extract(${alias}.data, '$.object.${path}')`;
const live = (alias: string) => `${alias}.scope = 'personal' AND ${alias}.kind = 'aide.dev/Topic'
  AND ${field(alias, "apiVersion")} = '${TOPIC_TYPE.apiVersion}' AND ${field(alias, "metadata.namespace")} = 'v1'
  AND ${field(alias, "metadata.deletionTimestamp")} IS NULL`;

/**
 * @spec Page live direct children of the current parent UID; only returned children need an indexed expandability lookup.
 * @why Organization navigation needs no ancestor, activity, Note, Input or Work projection.
 * @link docs/channel/web.md#主题组织
 * @case tests/topic-children.test.ts
 */
export function browseTopicChildren(store: TopicStore, topicId: string, query: PageQuery = {}) {
  const size = pageSize(query), storage = store.resources.storage, db = storage.db;
  return storage.transaction(() => {
    const parent = db.prepare(`SELECT t.uid FROM resources t WHERE t.key = ? AND ${live("t")}`)
      .get(store.resources.key(TOPIC_TYPE, digest(topicId)));
    if (!parent) return undefined;
    const parentUid = parent.uid as string;
    const candidates = `FROM resource_indexes i CROSS JOIN resources t ON t.key = i.source
      WHERE i.name = 'parent' AND i.value = ? AND ${live("t")}`;
    const total = Number(db.prepare(`SELECT count(*) AS n ${candidates}`).get(parentUid)!.n);
    const bounds = pageBounds(total, size, query.page);
    const rows = db.prepare(`WITH page AS MATERIALIZED (
      SELECT t.uid, ${field("t", "spec.id")} AS id, coalesce(nullif(${field("t", "spec.name")}, ''), ${field("t", "spec.id")}) AS name
      ${candidates} ORDER BY name COLLATE NOCASE, id, t.uid LIMIT ? OFFSET ?)
      SELECT page.*, EXISTS(SELECT 1 FROM resource_indexes children CROSS JOIN resources c ON c.key = children.source
        WHERE children.name = 'parent' AND children.value = page.uid AND ${live("c")}) AS hasChildren FROM page
      ORDER BY name COLLATE NOCASE, id, uid`).all(parentUid, size, (bounds.page - 1) * size);
    const items: TopicChild[] = rows.map(row => ({ id: row.id as string, uid: row.uid as string,
      name: row.name as string, hasChildren: Boolean(row.hasChildren) }));
    return { ...bounds, items };
  });
}
