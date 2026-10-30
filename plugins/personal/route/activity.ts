import { notes } from "../note/query.ts";
import type { Store } from "../store.ts";
import type { TopicResource } from "../topic/model.ts";

/** @spec Each Route candidate includes bounded recent activity even when its summary is absent or stale.
 * @why Indexed tree membership and SQL LIMIT keep historical Input bodies out of automatic context.
 * @link docs/personal/route.md#上下文组织与优化
 * @case tests/agent-context.test.ts
 */
export function recentActivity(store: Store, topic: TopicResource) {
  const field = (path: string) => `json_extract(r.data, '$.object.${path}')`;
  const rows = store.resources.storage.db.prepare(`WITH RECURSIVE tree(uid) AS (
    SELECT ? UNION SELECT r.uid FROM tree t JOIN resource_indexes i ON i.name='parent' AND i.value=t.uid
      JOIN resources r ON r.key=i.source WHERE r.scope='personal' AND ${field('apiVersion')}='aide.dev/v1alpha3' AND r.kind='aide.dev/Topic'
      AND ${field('metadata.deletionTimestamp')} IS NULL
  ) SELECT r.uid, r.kind, coalesce(${field('status.lastReport.at')}, r.created) AS at,
    substr(CASE WHEN r.kind='aide.dev/Input' THEN ${field('spec.text')}
      ELSE ${field('spec.title')} || ': ' || coalesce(${field('status.lastReport.text')}, '', '') END, 1, 240) AS text
    FROM tree t JOIN resource_indexes i ON i.name='topic' AND i.value=t.uid JOIN resources r ON r.key=i.source
    WHERE r.scope='personal' AND ((${field('apiVersion')}='aide.dev/v1alpha3' AND r.kind='aide.dev/Input') OR (${field('apiVersion')}='aide.dev/v1alpha3' AND r.kind IN ('aide.dev/Task','aide.dev/Routine')))
      AND ${field('metadata.deletionTimestamp')} IS NULL AND coalesce(${field('spec.origin')}, '') NOT IN ('aide:review', 'aide:triage', 'aide:organize')
    ORDER BY at DESC, r.uid DESC LIMIT 3`).all(topic.metadata.uid);
  const activity = [...rows.map(r => ({ uid: r.uid as string, kind: (r.kind as string).split('/').at(-1)!, at: r.at as string, text: r.text as string })),
    ...notes(store.resources, topic.metadata.uid).slice(-3).map(n => ({ uid: n.id, kind: "Note", at: n.updatedAt, text: n.text.slice(0, 240) }))];
  return activity.sort((a, b) => b.at.localeCompare(a.at) || a.uid.localeCompare(b.uid)).slice(0, 3);
}
