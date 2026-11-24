import { ONGOING_TYPE } from "../ongoing/model.ts";
import { HANDOFF_TYPE } from "../handoff/model.ts";
import { isGateTopic } from "./boundary.ts";
import { summaryText } from "../note/summary.ts";
import type { ResourceValidationContext } from "@compforge/aide-plugin";
import { TOPIC_TYPE, type TopicResource } from "./model.ts";
import { INPUT_TYPE } from "../input/model.ts";
import { WORK_TYPES } from "../work/resources.ts";
import { NOTE_TYPE, noteView } from "../note/model.ts";
import type { NoteReader } from "../note/query.ts";
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
 * @link docs/personal/topic.md#回收资格
 */
export function canReclaimTopic(topic: TopicResource, context: ResourceValidationContext): boolean {
  if (isGateTopic(topic) || topic.spec.default || topic.metadata.deletionTimestamp || topic.status.execution || topic.status.agent?.sessionId || topic.status.lastError) return false;
  const uid = topic.metadata.uid;
  if (context.page(HANDOFF_TYPE, { limit: 1, matchIndex: { name: "activeTopic", value: uid } }).items.length
    || context.page(ONGOING_TYPE, { limit: 1, matchIndex: { name: "openTopic", value: uid } }).items.length
    || context.page(TOPIC_TYPE, { limit: 1, matchIndex: { name: "parent", value: uid } }).items.length
    || context.page(INPUT_TYPE, { limit: 1, matchIndex: { name: "assessPending", value: uid } }).items.length
    || WORK_TYPES.some(t => context.page(t, { limit: 1, matchIndex: { name: "topic", value: uid } }).items.length)) return false;
  return knowledgeReleased(topic, context);
}

export function knowledgeReleased(topic: TopicResource, context: ResourceValidationContext): boolean {
  const uid = topic.metadata.uid;
  return (!summaryText(context, topic) && !context.page(NOTE_TYPE, { limit: 1, matchIndex: { name: "recentSubject", value: uid } }).items.length)
    || topic.status.reclamation?.version === reclamationVersion(topic, context);
}
