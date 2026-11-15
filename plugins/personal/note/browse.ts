import type { ResourceStorage } from "../../../src/host/resource/storage.ts";
import { pageBounds, pageSize, type PageQuery } from "../browse.ts";
import { NOTE_TYPE, noteView, type NoteResource } from "./model.ts";

/**
 * @spec Browse current related Notes by UID in stable newest-first pages; count before decoding only the selected page's bodies.
 * @why Human Note lists share indexed selection independently of the agent's recent context budget.
 * @link docs/channel/web.md
 */
export function browseNotePage(storage: ResourceStorage, uid: string | undefined, relation: "subject" | "people", query: PageQuery = {}) {
  const size = pageSize({ ...query, pageSize: query.pageSize ?? 5 }), db = storage.db;
  return storage.transaction(() => {
    if (!uid) return { ...pageBounds(0, size, query.page), items: [] };
    // Recent indexes exclude summaries, retired Notes and resources pending deletion at write time.
    const candidates = `FROM resource_ordered_indexes WHERE scope = 'personal' AND api_version = ? AND kind = 'Note'
      AND namespace = 'v1' AND index_name = ? AND index_value = ?`;
    const args = [NOTE_TYPE.apiVersion, relation === "subject" ? "recentSubject" : "recentPeople", uid];
    const total = Number(db.prepare(`SELECT count(*) AS n ${candidates}`).get(...args)!.n);
    const bounds = pageBounds(total, size, query.page);
    const rows = db.prepare(`WITH page AS MATERIALIZED (SELECT source, order_key, resource_name ${candidates}
      ORDER BY order_key DESC, resource_name DESC, source DESC LIMIT ? OFFSET ?)
      SELECT r.data FROM page JOIN resources r ON r.key = page.source
      ORDER BY page.order_key DESC, page.resource_name DESC, page.source DESC`).all(...args, size, (bounds.page - 1) * size);
    return { ...bounds, items: rows.map(row => noteView(storage.decode("personal", row.data as string).object as NoteResource)) };
  });
}
