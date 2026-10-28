import { isDeepStrictEqual } from "node:util";
import type { ResourceClient } from "@compforge/aide-plugin";
import { commitStatus } from "../status.ts";
import { setConditions } from "../conditions.ts";
import { resourceRef } from "../input/state.ts";
import { readTopicSubtree, pendingAbsorption, summaryVersion, topicSubtree } from "./tree.ts";
import type { TopicResource } from "./model.ts";

/** @spec SummaryCurrent observes the whole owned subtree; generation alone cannot describe child dependencies.
 * @why Version fences reject a judgment if a child changes between observation and commit. Child watches trigger a later refresh.
 * @link docs/personal/topic.md#status
 * @case tests/status.test.ts
 */
export async function refreshSummaryConditions(resources: ResourceClient, root: TopicResource): Promise<TopicResource> {
  const topics = await readTopicSubtree(resources, resourceRef(root));
  if (!topics.length) return root;
  const children = new Map<string, TopicResource[]>();
  for (const t of topics) if (t.spec.parentRef) children.set(t.spec.parentRef.uid, [...children.get(t.spec.parentRef.uid) ?? [], t]);
  const writes = topics.map(topic => {
    const subtree = topicSubtree(topic, p => children.get(p.metadata.uid) ?? []);
    const dependencies = Object.fromEntries(subtree.slice(1).map(t => [t.metadata.uid, summaryVersion(t)]));
    const pending = pendingAbsorption(subtree, topic).length;
    const conditions = setConditions(topic.status.conditions, [{ type: "SummaryCurrent", status: pending ? "False" : "True",
      reason: pending ? "ChildUnderstandingChanged" : "SummariesReviewed", message: `${pending} child summaries await review`, observedGeneration: topic.metadata.generation }]);
    return { operation: "patchStatus" as const, resource: topic, patch: { conditions, summaryDependencies: dependencies } };
  });
  if (writes.some(w => !isDeepStrictEqual(w.resource.status.conditions, w.patch.conditions) || !isDeepStrictEqual(w.resource.status.summaryDependencies, w.patch.summaryDependencies))) {
    await commitStatus(resources, writes);
    return (await resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(root)))!;
  }
  return root;
}
