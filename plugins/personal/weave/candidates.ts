import { createHash } from "node:crypto";
import type { TopicResource } from "../topic/model.ts";
import { understandingVersion, summaryVersion } from "../topic/tree.ts";
import { contextPage } from "../background.ts";

export function weaveCandidates(topics: readonly TopicResource[]) {
  return topics.filter(t => !t.metadata.deletionTimestamp && !t.spec.parentRef && !t.spec.default)
    .sort((a, b) => (a.status.lastInputAt ?? a.metadata.creationTimestamp).localeCompare(b.status.lastInputAt ?? b.metadata.creationTimestamp) || a.metadata.uid.localeCompare(b.metadata.uid));
}
export function candidateVersion(topic: TopicResource) {
  return createHash("sha256").update(JSON.stringify([topic.spec.name, summaryVersion(topic)])).digest("hex");
}
/** @spec Scan progress measures the actual bounded snapshot supplied to inference, never the requested page size.
 * @link docs/personal/weave.md
 */
export function candidatePage(roots: readonly TopicResource[], offset: number, limit: number) {
  return contextPage(roots.map(t => ({ uid: t.metadata.uid, name: t.spec.name?.slice(0, 200), summary: t.status.summary.slice(0, 1200),
    version: understandingVersion(t), lastInputAt: t.status.lastInputAt })), offset, limit);
}
