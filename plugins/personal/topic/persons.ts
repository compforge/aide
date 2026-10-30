import { notes } from "../note/query.ts";
import type { Store } from "../store.ts";
import { PERSON_TYPE, type PersonRef } from "../person/model.ts";
import type { TopicResource } from "./model.ts";

const PERSON_LIMIT = 8;

/** @spec Related people come only from this Topic's recent Notes; they are an incomplete contextual clue.
 * @why No Input/subtree query or retention touch is needed to render recent matter associations.
 * @spec Historical UIDs never resolve to replacement Persons with the same name.
 * @case tests/topic-persons.test.ts
 * @link docs/personal/topic.md#近期相关人物
 */
export function topicPersons(store: Store, topic: TopicResource) {
  const people = new Map<string, PersonRef>();
  for (const note of [...notes(store.resources, topic.metadata.uid, "subject")].reverse()) for (const ref of note.people ?? []) {
    if (!people.has(ref.uid)) people.set(ref.uid, ref);
  }
  const refs = [...people.values()].slice(0, PERSON_LIMIT);
  // One read-only projection: no private profiles, LRU writes or per-Person transactions.
  const rows = refs.length ? store.resources.storage.db.prepare(`SELECT uid,
    json_extract(data, '$.object.metadata.name') AS id, json_extract(data, '$.object.spec.name') AS name
    FROM resources WHERE scope='personal' AND kind='aide.dev/Person'
      AND json_extract(data, '$.object.apiVersion')=? AND json_extract(data, '$.object.metadata.namespace')='v1'
      AND json_extract(data, '$.object.metadata.deletionTimestamp') IS NULL
      AND uid IN (SELECT value FROM json_each(?))`).all(PERSON_TYPE.apiVersion, JSON.stringify(refs.map(ref => ref.uid))) : [];
  const byUid = new Map(rows.map(row => [row.uid, row]));
  const items = refs.map(ref => {
    const person = byUid.get(ref.uid);
    return { ref, ...(ref.apiVersion === PERSON_TYPE.apiVersion && person?.id === ref.name
      ? { name: String(person.name).slice(0, 200) } : { unavailable: true }) };
  });
  return { items, source: "recentNotes" as const, noteCount: notes(store.resources, topic.metadata.uid, "subject").length,
    omittedPersons: Math.max(0, people.size - items.length) };
}

export type TopicPersons = ReturnType<typeof topicPersons>;
