import { type PageQuery } from "../browse.ts";
import { browseNotePage } from "../note/browse.ts";
import type { TopicStore } from "./store.ts";

/**
 * @spec Topic Note pages use the current subject UID and newest-first index; only the selected page's bodies are decoded.
 * @why Human browsing must cover retained Notes beyond the agent's recent context budget, without loading message history.
 * @link docs/channel/web.md#工作管理
 * @case tests/topic-notes.test.ts
 */
export function browseTopicNotes(store: TopicStore, topicId: string, query: PageQuery = {}) {
  return store.resources.storage.transaction(() => {
    const topic = store.resource(topicId);
    return browseNotePage(store.resources.storage, topic?.metadata.uid, "subject", query);
  });
}
