import { createHash } from "node:crypto";
import type { TopicResource } from "../topic/model.ts";
import { understandingVersion, summaryVersion } from "../topic/tree.ts";
import { contextPage } from "../background.ts";

export function weaveCandidates(topics: readonly TopicResource[]) {
  return topics.filter(t => !t.metadata.deletionTimestamp && !t.spec.parentRef && !t.spec.default)
    .sort((a, b) => (a.status.lastInputAt ?? a.metadata.creationTimestamp).localeCompare(b.status.lastInputAt ?? b.metadata.creationTimestamp) || a.metadata.uid.localeCompare(b.metadata.uid));
}
/** @why Review receipts depend on the candidate-view contract as well as Topic understanding.
 * Changing this contract invalidates old checks once, without repeatedly resetting scan progress.
 * @case tests/weave.test.ts
 */
const REVIEW_CONTRACT = "root-catalog-v2";
export function candidateVersion(topic: TopicResource) {
  return createHash("sha256").update(JSON.stringify([REVIEW_CONTRACT, topic.spec.name, summaryVersion(topic), topic.status.organization])).digest("hex");
}
/** @spec Scan progress measures the actual bounded snapshot supplied to inference, never the requested page size.
 * @link docs/personal/weave.md
 */
export function candidatePage(roots: readonly TopicResource[], offset: number, limit: number) {
  return contextPage(roots.map(t => ({ uid: t.metadata.uid, name: t.spec.name?.slice(0, 200), summary: t.status.summary.slice(0, 1200),
    version: understandingVersion(t), lastInputAt: t.status.lastInputAt, organization: t.status.organization })), offset, limit);
}

/** @spec Search counts describe matching roots, independently of the global catalog and pending review batch.
 * @case tests/weave.test.ts
 */
export function searchRootTopics(roots: readonly TopicResource[], query: string | undefined, offset: number, limit: number) {
  const matching = roots.filter(t => !query || [t.spec.name, t.status.summary].join(" ").toLowerCase().includes(query.toLowerCase()));
  const { total: matchingRootCount, ...page } = candidatePage(matching, offset, limit);
  return { rootCount: roots.length, matchingRootCount, query: query ?? null, ...page };
}
