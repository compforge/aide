import type { ResourceStorage } from "../../../src/host/resource/storage.ts";
import { pageBounds, pageSize, type PageQuery } from "../browse.ts";
import { ONGOING_TYPE } from "./model.ts";
import { TOPIC_TYPE } from "../topic/model.ts";

interface GateOngoing {
  id: string; uid: string; title: string; question: string | null; progress: string | null;
  checkAt: string | null; topicId: string | null; topicName: string | null;
}
export type GateOngoingPage = ReturnType<typeof browseOpenOngoings>;

/** @spec Gate pages open matters across all Topics, earliest check first, unscheduled last.
 * @link docs/channel/web.md
 */
export function browseOpenOngoings(storage: ResourceStorage, query: PageQuery) {
  const size = pageSize(query);
  const where = `o.scope = 'personal' AND o.kind = 'aide.dev/Ongoing' AND json_extract(o.data, '$.object.apiVersion') = ?
    AND json_extract(o.data, '$.object.metadata.deletionTimestamp') IS NULL AND json_extract(o.data, '$.object.status.closure') IS NULL`;
  return storage.transaction(() => {
    const total = Number(storage.db.prepare(`SELECT count(*) AS n FROM resources o WHERE ${where}`).get(ONGOING_TYPE.apiVersion)!.n);
    const bounds = pageBounds(total, size, query.page);
    const items = storage.db.prepare(`SELECT o.uid, json_extract(o.data, '$.object.metadata.name') AS id, json_extract(o.data, '$.object.spec.title') AS title,
      json_extract(o.data, '$.object.spec.question') AS question, json_extract(o.data, '$.object.status.progress') AS progress,
      json_extract(o.data, '$.object.status.nextCheckAt') AS checkAt,
      json_extract(t.data, '$.object.spec.id') AS topicId, json_extract(t.data, '$.object.spec.name') AS topicName
      FROM resources o LEFT JOIN resources t ON t.uid = json_extract(o.data, '$.object.spec.topic.uid')
        AND t.scope = o.scope AND t.kind = 'aide.dev/Topic' AND json_extract(t.data, '$.object.apiVersion') = ?
      WHERE ${where} ORDER BY checkAt IS NULL, julianday(checkAt), o.uid LIMIT ? OFFSET ?`)
      .all(TOPIC_TYPE.apiVersion, ONGOING_TYPE.apiVersion, size, (bounds.page - 1) * size) as unknown as GateOngoing[];
    return { ...bounds, items };
  });
}
