import { isDeepStrictEqual } from "node:util";
import type { PluginContext, ResourceClient, Watch } from "@compforge/aide-plugin";
import { patchStatus } from "../status.ts";
import { setConditions } from "../conditions.ts";
import { summaryVersion } from "./tree.ts";
import { TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "./model.ts";

/** @spec Each Topic observes direct children and writes only its own status; child observations converge through Watch.
 * @why SummaryCurrent describes recorded dependencies, not an atomic snapshot or permission to reorganize/delete resources.
 * @link docs/personal/topic.md#status
 * @case tests/status.test.ts
 */
export async function refreshSummaryConditions(resources: ResourceClient, topic: TopicResource): Promise<TopicResource> {
  const children = (await resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE, {
    namespace: topic.metadata.namespace, matchIndex: { name: "parent", value: topic.metadata.uid },
  })).filter(child => !child.metadata.deletionTimestamp);
  const dependencies = Object.fromEntries(children.map(child => [child.metadata.uid, summaryVersion(child)]));
  const pending = children.filter(child => topic.status.absorbedSummaries?.[child.metadata.uid] !== summaryVersion(child)).length;
  const observations = children.map(child => child.status.conditions?.find(c => c.type === "SummaryCurrent" && c.observedGeneration === child.metadata.generation)?.status);
  const descendantPending = observations.some(status => status === "False");
  const unknown = observations.some(status => !status || status === "Unknown");
  const status = pending || descendantPending ? "False" : unknown ? "Unknown" : "True";
  const conditions = setConditions(topic.status.conditions, [{ type: "SummaryCurrent", status,
    reason: pending ? "ChildUnderstandingChanged" : descendantPending ? "DescendantUnderstandingChanged" : unknown ? "AwaitingChildObservation" : "SummariesReviewed",
    message: `${pending} direct child summaries await review`, observedGeneration: topic.metadata.generation }]);
  // Preserve the evidence's actual age. Maintenance does not create business activity.
  const lastInputAt = [topic.status.lastInputAt, ...children.map(child => child.status.lastInputAt)]
    .filter((at): at is string => !!at).sort().at(-1);
  const patch = { conditions, summaryDependencies: dependencies, ...(lastInputAt ? { lastInputAt } : {}) };
  if (isDeepStrictEqual(topic.status.conditions, conditions) && isDeepStrictEqual(topic.status.summaryDependencies, dependencies)
    && topic.status.lastInputAt === lastInputAt) return topic;
  return patchStatus(resources, topic, patch);
}

/** Only dependency changes wake the parent; conditions-only writes never wake their own observer. */
export function summaryWatch(): Watch {
  const requests = (current: TopicResource, previous?: TopicResource, includeSelf = false) => {
    const refs = [current.spec.parentRef, previous?.spec.parentRef, ...(includeSelf ? [current.metadata] : [])];
    return [...new Map(refs.filter(ref => !!ref).map(ref => [ref!.uid, { name: ref!.name, namespace: ref!.namespace }])).values()];
  };
  return { resourceType: TOPIC_TYPE, handler: {
    create: async ({ object }) => requests(object as TopicResource, undefined, true),
    delete: async ({ object }) => requests(object as TopicResource),
    update: async ({ oldObject, newObject }) => {
      const a = oldObject as TopicResource, b = newObject as TopicResource;
      const own = a.metadata.generation !== b.metadata.generation || !isDeepStrictEqual(a.status.absorbedSummaries, b.status.absorbedSummaries);
      const condition = (t: TopicResource) => t.status.conditions?.find(c => c.type === "SummaryCurrent");
      const parent = summaryVersion(a) !== summaryVersion(b) || !isDeepStrictEqual(condition(a), condition(b))
        || !isDeepStrictEqual(a.status.summaryDependencies, b.status.summaryDependencies)
        || a.status.lastInputAt !== b.status.lastInputAt || a.metadata.deletionTimestamp !== b.metadata.deletionTimestamp;
      return own || parent ? requests(b, a, own) : [];
    },
  } };
}

export function registerTopicObservations(context: PluginContext) {
  context.controllers.register({ name: "summary", resourceType: TOPIC_TYPE, maxConcurrency: 4, watches: [summaryWatch()],
    async reconcile(_execution, topic: TopicResource) {
      if (topic.metadata.deletionTimestamp) return;
      let updated;
      try { updated = await refreshSummaryConditions(context.resources, topic); }
      catch (error) {
        if (/version conflict/.test(String(error))) return { requeueAfterMs: 1 };
        throw error;
      }
      if (updated.metadata.resourceVersion !== topic.metadata.resourceVersion) context.logger.debug("Topic summary observation updated", {
        attributes: { topicUid: topic.metadata.uid, status: updated.status.conditions?.find(c => c.type === "SummaryCurrent")?.status ?? "Unknown",
          children: Object.keys(updated.status.summaryDependencies ?? {}).length },
      });
    },
  });
}
