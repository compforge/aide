import type { Store } from "../store.ts";
import { INPUT_TYPE } from "../input/model.ts";
import { SOURCES } from "../source/definition.ts";
import { PERSON_TYPE, PersonRefSchema, type Person, type PersonStatus, type PersonRef } from "../person/model.ts";
import { TOPIC_TYPE, type TopicResource } from "./model.ts";

const WINDOW_DAYS = 7;
const INPUT_LIMIT = 50;
const PERSON_LIMIT = 8;

/** @spec Related people are a derived sample of current subtree Inputs, not Topic-owned identity or a merge rule.
 * @why Time/count bounds and projected references keep historical bodies and private profiles out of automatic context.
 * @spec Missing or empty receivers never means all; missing/recreated Persons retain their historical UID without aliasing.
 * @case tests/topic-persons.test.ts
 * @link docs/personal/topic.md#近期相关人物
 */
export function topicPersons(store: Store, topic: TopicResource, now = Date.now()) {
  return store.resources.storage.transaction(() => {
    const field = (path: string) => `json_extract(r.data, '$.object.${path}')`;
    const rows = store.resources.storage.db.prepare(`WITH RECURSIVE tree(uid) AS (
      SELECT uid FROM resources WHERE scope='personal' AND uid=? AND kind='aide.dev/Topic'
        AND json_extract(data, '$.object.apiVersion')=? AND json_extract(data, '$.object.metadata.namespace')='v1'
        AND json_extract(data, '$.object.metadata.deletionTimestamp') IS NULL
      UNION SELECT r.uid FROM tree t JOIN resource_indexes i ON i.name='parent' AND i.value=t.uid
        JOIN resources r ON r.key=i.source WHERE r.scope='personal' AND r.kind='aide.dev/Topic'
        AND ${field('apiVersion')}=? AND ${field('metadata.namespace')}='v1' AND ${field('metadata.deletionTimestamp')} IS NULL
    ), sampled AS MATERIALIZED (
      SELECT r.data, r.created, r.uid FROM tree t JOIN resource_indexes i ON i.name='topic' AND i.value=t.uid
        JOIN resources r ON r.key=i.source WHERE r.scope='personal' AND r.kind='aide.dev/Input'
        AND ${field('apiVersion')}=? AND ${field('metadata.namespace')}='v1' AND ${field('metadata.deletionTimestamp')} IS NULL
        AND ${field('spec.origin')} IN ('source','channel') AND r.created>=?
      ORDER BY r.created DESC, r.uid DESC LIMIT ?
    ) SELECT ${field('spec.sender')} AS sender, ${field('spec.receivers')} AS receivers,
      CASE WHEN ${field('spec.origin')}='source' AND ${field('spec.originId')}=? THEN
        json_array(${field('spec.observation.message.person')}) ELSE '[]' END AS authors,
      CASE WHEN ${field('spec.origin')}='source' AND ${field('spec.originId')}=? THEN
        (SELECT json_group_array(json_object('person',json_extract(m.value,'$.person'), 'receivers',json_extract(m.value,'$.receivers')))
          FROM json_each(r.data, '$.object.spec.observation.context.messages') m WHERE m.type='object') ELSE '[]' END AS participants
      FROM sampled r ORDER BY r.created DESC, r.uid DESC`).all(topic.metadata.uid, TOPIC_TYPE.apiVersion, TOPIC_TYPE.apiVersion,
        INPUT_TYPE.apiVersion, new Date(now - WINDOW_DAYS * 86400_000).toISOString(), INPUT_LIMIT + 1, SOURCES.lark.id, SOURCES.lark.id);
    const people = new Map<string, PersonRef>();
    const add = (value: unknown) => {
      const parsed = PersonRefSchema.safeParse(value);
      if (parsed.success && parsed.data.apiVersion === PERSON_TYPE.apiVersion && parsed.data.namespace === "v1") people.set(parsed.data.uid, parsed.data);
    };
    const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
    for (const row of rows.slice(0, INPUT_LIMIT)) {
      if (row.sender) add(JSON.parse(row.sender as string));
      array(JSON.parse(row.receivers as string ?? "[]")).forEach(add);
      array(JSON.parse(row.authors as string)).forEach(add);
      for (const item of array(JSON.parse(row.participants as string))) {
        if (!item || typeof item !== "object") continue;
        const participant = item as { person?: unknown; receivers?: unknown };
        add(participant.person); array(participant.receivers).forEach(add);
      }
    }
    const items = [...people.values()].slice(0, PERSON_LIMIT).map(ref => {
      const person = store.resources.find<Person, PersonStatus>(PERSON_TYPE, ref.name, ref.namespace);
      const available = person && !person.metadata.deletionTimestamp && person.metadata.uid === ref.uid;
      return { ref, ...(available ? { name: person.spec.name.slice(0, 200) } : { unavailable: true }) };
    });
    return { items, windowDays: WINDOW_DAYS, sampledInputs: Math.min(rows.length, INPUT_LIMIT), inputLimit: INPUT_LIMIT,
      hasMoreInputs: rows.length > INPUT_LIMIT, omittedPersons: Math.max(0, people.size - items.length) };
  });
}

export type TopicPersons = ReturnType<typeof topicPersons>;
