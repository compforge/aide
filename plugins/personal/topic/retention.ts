import type { ResourceValidationContext } from "@compforge/aide-plugin";
import { TOPIC_TYPE, type TopicResource } from "./model.ts";
import { INPUT_TYPE } from "../input/model.ts";
import { WORK_TYPES } from "../resources.ts";
import { NOTE_TYPE, noteView } from "../note/model.ts";
import type { NoteReader } from "../note/query.ts";
import { notes } from "../note/query.ts";
import { understandingVersion } from "./tree.ts";

export function reclamationVersion(topic: TopicResource, reader: NoteReader): string {
  const all = reader.list<import("../note/model.ts").NoteSpec, import("../note/model.ts").NoteStatus>(NOTE_TYPE,
    { matchIndex: { name: "subject", value: topic.metadata.uid } }).filter(n => !n.metadata.deletionTimestamp).map(noteView)
    .sort((a, b) => a.uid.localeCompare(b.uid));
  return understandingVersion(topic, all);
}
/** @spec Capacity rechecks current execution, dependencies and knowledge in the eviction transaction.
 * @why A release timestamp orders candidates; it cannot certify dependencies that may change independently.
 * @case tests/note-knowledge.test.ts
 * @link docs/personal/topic.md#静默回收
 */
export function canReclaimTopic(topic: TopicResource, context: ResourceValidationContext): boolean {
  if (topic.spec.default || topic.metadata.deletionTimestamp || topic.status.execution || topic.status.agent?.sessionId || topic.status.lastError) return false;
  const uid = topic.metadata.uid;
  if (context.page(TOPIC_TYPE, { limit: 1, matchIndex: { name: "parent", value: uid } }).items.length
    || context.page(INPUT_TYPE, { limit: 1, matchIndex: { name: "assessPending", value: uid } }).items.length
    || WORK_TYPES.some(t => context.page(t, { limit: 1, matchIndex: { name: "topic", value: uid } }).items.length)) return false;
  const recent = notes(context, uid), version = understandingVersion(topic, recent);
  if (topic.spec.parentRef) {
    if (context.page(NOTE_TYPE, { limit: 1, matchIndex: { name: "unreviewed", value: uid } }).items.length) return false;
    const parent = context.get<TopicResource["spec"], TopicResource["status"]>(topic.spec.parentRef, topic.spec.parentRef.uid);
    return !!parent && !parent.metadata.deletionTimestamp && parent.status.absorbed?.[uid] === version;
  }
  return (!topic.status.summary && !context.page(NOTE_TYPE, { limit: 1, matchIndex: { name: "subject", value: uid } }).items.length)
    || topic.status.reclamation?.version === reclamationVersion(topic, context);
}
