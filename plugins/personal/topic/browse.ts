import { digest } from "../chief-model.ts";
import type { TopicStore } from "./store.ts";
import { initialTopicName, TOPIC_TYPE } from "./model.ts";
import { topicReview, type TopicReview } from "./review.ts";
import { pageBounds, pageSize, type PageQuery } from "../browse.ts";

export interface TopicBrowseQuery extends PageQuery { parentId?: string; q?: string; selectedId?: string }
export interface TopicListItem {
  id: string; uid: string; revision: number; name: string; topicKey?: string; parentUid?: string;
  review: TopicReview; default: boolean; preview: string; updatedAt: string; taskCount: number; routineCount: number; childCount: number;
}
const field = (alias: string, path: string) => `json_extract(${alias}.data, '$.object.${path}')`;
const activeTopic = (alias: string) => `${alias}.scope = 'personal' AND ${alias}.kind = 'aide.dev/Topic' AND ${field(alias, "apiVersion")} = 'aide.dev/v1alpha3'
  AND ${field(alias, "metadata.namespace")} = 'v1' AND ${field(alias, "metadata.deletionTimestamp")} IS NULL`;
const activeInput = `r.scope = 'personal' AND r.kind = 'aide.dev/Input' AND ${field("r", "apiVersion")} = 'aide.dev/v1alpha3' AND ${field("r", "metadata.namespace")} = 'v1'
  AND ${field("r", "metadata.deletionTimestamp")} IS NULL`;
const output = `o.scope = 'personal' AND o.kind = 'aide.dev/Output' AND ${field("o", "metadata.namespace")} = 'v1'
  AND ${field("o", "metadata.deletionTimestamp")} IS NULL`;
// Keep indexed edges first and point-read their resources; SQLite otherwise favors per-Topic kind/time scans.
const replies = `SELECT o.key, o.created FROM resource_indexes i CROSS JOIN resources o INDEXED BY resource_scope ON o.key = i.source
    WHERE i.name = 'topic' AND i.value = c.uid AND ${output}
  UNION
  SELECT o.key, o.created FROM resource_indexes i CROSS JOIN resources o INDEXED BY resource_scope ON o.key = i.source
    CROSS JOIN resources producer ON producer.uid = ${field("o", "spec.topic.uid")}
    WHERE i.name = 'webEndpoint' AND i.value = c.id AND ${output} AND ${activeTopic("producer")}
      AND o.created >= c.created AND ${field("o", "spec.topicId")} <> c.id`;
const facts = (predicate = "") => `, facts AS MATERIALIZED (SELECT c.*,
    (SELECT max(r.created) FROM resource_indexes i CROSS JOIN resources r ON r.key = i.source
      WHERE i.name = 'topic' AND i.value = c.uid AND ${activeInput}) AS inputAt,
    (SELECT key FROM (${replies}) ORDER BY created DESC, key DESC LIMIT 1) AS replyKey
  FROM candidates c ${predicate}), activity AS (SELECT f.*, max(created, coalesce(lastInputAt, ''), coalesce(inputAt, ''),
    coalesce((SELECT created FROM resources WHERE key = f.replyKey), '')) AS updatedAt FROM facts f)`;
const columns = `t.key, t.uid, t.created, ${field("t", "spec.id")} AS id, ${field("t", "metadata.resourceVersion")} AS revision,
  ${field("t", "spec.name")} AS name, ${field("t", "spec.topicKey")} AS topicKey,
  ${field("t", "spec.parentRef.uid")} AS parentUid, coalesce(${field("t", "spec.default")}, 0) AS isDefault,
  ${field("t", "spec.review")} AS review, ${field("t", "status.lastInputAt")} AS lastInputAt`;
const order = "updatedAt DESC, id ASC, uid ASC";

/**
 * @spec Page siblings in SQL after activity ordering. Default is pinned outside root totals; the parent filter selects direct children and defaults to roots.
 * @spec Child counts use indexed live direct children, independent of search and paging; descendants are excluded.
 * @spec Quiet Inputs change activity without replacing the reply preview; UID checks prevent recreated Topics inheriting old replies.
 * @why Lists read only lightweight columns and indexed facts, never TopicStore.project or global Input/Output/Work views.
 * @link docs/channel/web.md#会话导航
 */
export function browseTopics(store: TopicStore, query: TopicBrowseQuery = {}) {
  const size = pageSize(query), storage = store.resources.storage, db = storage.db;
  return storage.transaction(() => {
    const lookup = (id: string) => db.prepare(`SELECT ${columns} FROM resources t WHERE t.key = ? AND ${activeTopic("t")}`)
      .get(store.resources.key(TOPIC_TYPE, digest(id)));
    const parent = query.parentId ? lookup(query.parentId) : undefined;
    const members = query.parentId ? "parent" : "root", value = query.parentId ? parent?.uid ?? "" : "root";
    const args = [members, value, ...(query.q ? [query.q, query.q] : [])];
    const candidates = `WITH candidates AS (SELECT ${columns} FROM resource_indexes membership CROSS JOIN resources t ON t.key = membership.source
      WHERE membership.name = ? AND membership.value = ? AND ${activeTopic("t")}${query.q ? ` AND (instr(lower(coalesce(${field("t", "spec.name")}, '')), lower(?)) > 0
        OR instr(lower(${field("t", "spec.id")}), lower(?)) > 0)` : ""})`;
    const counts = new Map<string, { taskCount: number; routineCount: number }>();
    const childCounts = new Map<string, number>();
    const project = (row: Record<string, unknown>): TopicListItem => {
      const reply = row.replyKey ? db.prepare(`SELECT ${field("r", "spec.text")} AS text FROM resources r WHERE key = ?`).get(row.replyKey as string) : undefined;
      const pending = !row.name ? db.prepare(`SELECT ${field("r", "spec.text")} AS text FROM resource_indexes i CROSS JOIN resources r ON r.key = i.source
        WHERE i.name = 'assessPending' AND i.value = ? AND ${activeInput} ORDER BY r.created, r.key LIMIT 1`).get(row.uid as string) : undefined;
      return { id: row.id as string, uid: row.uid as string, revision: Number(row.revision),
        name: row.name as string || initialTopicName(pending?.text as string ?? "") || "未命名会话",
        ...(row.topicKey ? { topicKey: row.topicKey as string } : {}), ...(row.parentUid ? { parentUid: row.parentUid as string } : {}),
        review: topicReview(row.review ? JSON.parse(row.review as string) : undefined), default: Boolean(row.isDefault),
        childCount: childCounts.get(row.uid as string) ?? 0,
        preview: (reply?.text as string ?? "").replace(/\s+/g, " ").trim().slice(0, 100), updatedAt: row.updatedAt as string,
        ...(counts.get(row.uid as string) ?? { taskCount: 0, routineCount: 0 }) };
    };
    // Fetch exactly the selected ancestor chain; opening a deep link never enumerates the directory.
    const ancestors: Record<string, unknown>[] = [];
    let current = query.selectedId ? lookup(query.selectedId) : undefined;
    const seen = new Set<string>();
    while (current && !seen.has(current.uid as string)) {
      seen.add(current.uid as string); ancestors.unshift(current);
      const ref = current.parentUid;
      if (!ref) break;
      current = db.prepare(`SELECT ${columns} FROM resources t WHERE t.uid = ? AND ${activeTopic("t")}`).get(ref);
    }
    const total = Number(db.prepare(`${candidates} SELECT count(*) AS n FROM candidates WHERE NOT isDefault`).get(...args)!.n);
    let requested = query.page;
    const selected = query.parentId ? ancestors.find(t => t.parentUid === parent?.uid) : ancestors[0];
    if (requested === undefined && selected) {
      const position = db.prepare(`${candidates}${facts()} SELECT position FROM
        (SELECT uid, row_number() OVER (ORDER BY ${order}) AS position FROM activity WHERE NOT isDefault) WHERE uid = ?`)
        .get(...args, selected.uid as string);
      if (position) requested = Math.ceil(Number(position.position) / size);
    }
    const bounds = pageBounds(total, size, requested);
    const itemRows = db.prepare(`${candidates}${facts()} SELECT * FROM activity WHERE NOT isDefault ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...args, size, (bounds.page - 1) * size);
    const pinnedRows = db.prepare(`${candidates}${facts("WHERE isDefault")} SELECT * FROM activity ORDER BY id`).all(...args);
    const pathRows = ancestors.map(topic => {
      const row = db.prepare(`WITH candidates AS (SELECT ${columns} FROM resources t WHERE t.uid = ? AND ${activeTopic("t")})${facts()} SELECT * FROM activity`).get(topic.uid as string);
      return row;
    }).filter((row): row is NonNullable<typeof row> => !!row);
    const ids = [...new Set([...itemRows, ...pinnedRows, ...pathRows].map(row => row.uid as string))];
    if (ids.length) {
      const children = db.prepare(`SELECT i.value AS parentUid, count(*) AS n FROM resource_indexes i CROSS JOIN resources t ON t.key = i.source
        WHERE i.name = 'parent' AND i.value IN (${ids.map(() => "?").join(",")}) AND ${activeTopic("t")} GROUP BY i.value`).all(...ids);
      for (const row of children) childCounts.set(row.parentUid as string, Number(row.n));
      const rows = db.prepare(`SELECT i.value AS topicId, r.kind, count(*) AS n FROM resource_indexes i CROSS JOIN resources r ON r.key = i.source
        WHERE i.name = 'topic' AND i.value IN (${ids.map(() => "?").join(",")}) AND r.scope = 'personal'
          AND r.kind IN ('aide.dev/Task', 'aide.dev/Routine') AND ${field("r", "apiVersion")} = 'aide.dev/v1alpha3' AND ${field("r", "metadata.namespace")} = 'v1'
          AND ${field("r", "metadata.deletionTimestamp")} IS NULL GROUP BY i.value, r.kind`).all(...ids);
      for (const row of rows) {
        const value = counts.get(row.topicId as string) ?? { taskCount: 0, routineCount: 0 };
        if (row.kind === "aide.dev/Task") value.taskCount = Number(row.n); else value.routineCount = Number(row.n);
        counts.set(row.topicId as string, value);
      }
    }
    return { ...bounds, items: itemRows.map(project), pinned: pinnedRows.map(project), path: pathRows.map(project) };
  });
}
