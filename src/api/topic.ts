import { summaryText, summaryReference } from "../../plugins/personal/note/summary.ts";
import { notes } from "../../plugins/personal/note/query.ts";
import type { TopicStore } from "../../plugins/personal/topic/store.ts";
export { browseTopicNotes } from "../../plugins/personal/topic/notes.ts";

/** @spec Summary and recent Notes are independent indexed reads; neither projects dialogue or execution history. */
export function topicSummary(store: TopicStore, id: string) {
  const topic = store.resource(id);
  return { summary: topic ? summaryText(store.resources, topic) : "", summaryNote: topic ? summaryReference(store.resources, topic) : undefined };
}
export function topicRecent(store: TopicStore, id: string) {
  const topic = store.resource(id);
  return topic ? notes(store.resources, topic.metadata.uid, "subject") : [];
}
