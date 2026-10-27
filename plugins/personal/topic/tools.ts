import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Store } from "../store.ts";
import type { TopicResource } from "./model.ts";
import { understandingVersion } from "./tree.ts";
import { contextPage, understanding } from "../background.ts";
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });
/** Root agents may inspect their own subtree, never expand unrelated trees into automatic context. */
export function topicTools(store: Store, active: () => TopicResource): ToolDefinition[] {
  const subtree = () => store.topics.scope(active().metadata.uid);
  return [
    { name: "list_topics", label: "List child topics", description: "List direct children within this root's subtree with summary and Note previews for discovery. Text ending in [truncated] is incomplete; noteTotal counts all Notes, including omitted ones. Before relying on incomplete context or confirming absorbed versions, use read_topic(uid) and continue with offset=nextOffset until the needed context is read. Follow this list's nextOffset to discover remaining children.",
      parameters: Type.Object({ parentUid: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      async execute(_id, { parentUid, offset = 0 }) {
        const root = active(), parent = parentUid ?? root.metadata.uid;
        const all = subtree();
        if (!all.some(t => t.metadata.uid === parent)) throw new Error("Topic is outside this root");
        return result(contextPage(all.filter(t => t.spec.parentRef?.uid === parent).map(t => ({
          uid: t.metadata.uid, name: t.spec.name, ...understanding(t.status, 1200), version: understandingVersion(t),
        })), offset));
      } },
    { name: "read_topic", label: "Read topic", description: "Read this root or a descendant's full summary and Notes in text pages. A non-null nextOffset means more text remains: continue with offset=nextOffset; null marks the end. Use its resource version for summarize_topic and understandingVersion for absorbed receipts after reviewing the child context.",
      parameters: Type.Object({ uid: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }),
      async execute(_id, { uid, offset = 0 }) {
        const root = active(), topic = subtree().find(t => t.metadata.uid === (uid ?? root.metadata.uid));
        if (!topic) throw new Error("Topic is outside this root");
        const text = JSON.stringify({ ...topic.spec, summary: topic.status.summary, recent: topic.status.recent });
        return result({ uid: topic.metadata.uid, version: topic.metadata.resourceVersion, understandingVersion: understandingVersion(topic),
          text: text.slice(offset, offset + 8000), nextOffset: offset + 8000 < text.length ? offset + 8000 : null });
      } },
  ];
}
