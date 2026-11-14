import { pageBounds, pageSize, type PageQuery } from "../browse.ts";
import { NOTE_TYPE, noteView, type NoteResource } from "../note/model.ts";
import type { TopicStore } from "./store.ts";

/**
 * @spec Topic Note pages use the current subject UID and newest-first index; only the selected page's bodies are decoded.
 * @why Human browsing must cover retained Notes beyond the agent's recent context budget, without loading message history.
 * @link docs/channel/web.md#工作管理
 * @case tests/topic-notes.test.ts
 */
export function browseTopicNotes(store: TopicStore, topicId: string, query: PageQuery = {}) {
  const size = pageSize({ ...query, pageSize: query.pageSize ?? 5 }), storage = store.resources.storage, db = storage.db;
  return storage.transaction(() => {
    const topic = store.resource(topicId);
    if (!topic) return { ...pageBounds(0, size, query.page), items: [] };
    // recentSubject excludes summary Notes, retired Notes and resources pending deletion at index-write time.
    const candidates = `FROM resource_ordered_indexes WHERE scope = 'personal' AND api_version = ? AND kind = 'Note'
      AND namespace = 'v1' AND index_name = 'recentSubject' AND index_value = ?`;
    const args = [NOTE_TYPE.apiVersion, topic.metadata.uid];
    const total = Number(db.prepare(`SELECT count(*) AS n ${candidates}`).get(...args)!.n);
    const bounds = pageBounds(total, size, query.page);
    const rows = db.prepare(`WITH page AS MATERIALIZED (SELECT source, order_key, resource_name ${candidates}
      ORDER BY order_key DESC, resource_name DESC, source DESC LIMIT ? OFFSET ?)
      SELECT r.data FROM page JOIN resources r ON r.key = page.source
      ORDER BY page.order_key DESC, page.resource_name DESC, page.source DESC`).all(...args, size, (bounds.page - 1) * size);
    return { ...bounds, items: rows.map(row => noteView(storage.decode("personal", row.data as string).object as NoteResource)) };
  });
}
