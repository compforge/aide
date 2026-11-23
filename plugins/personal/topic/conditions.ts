import { isGateTopic, isGateParent } from "./boundary.ts";
import type { PluginContext, ResourceClient, Watch } from "@compforge/aide-plugin";
import { patchStatus } from "../status.ts";
import { TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "./model.ts";

/** Child business activity propagates to ancestors independently of Note maintenance. */
export async function refreshTopicActivity(resources: ResourceClient, topic: TopicResource): Promise<TopicResource> {
  const children = (await resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE, {
    namespace: topic.metadata.namespace, matchIndex: { name: "parent", value: topic.metadata.uid },
  })).filter(child => !child.metadata.deletionTimestamp);
  const lastInputAt = [topic.status.lastInputAt, ...children.map(child => child.status.lastInputAt)]
    .filter((at): at is string => !!at).sort().at(-1);
  return lastInputAt && topic.status.lastInputAt !== lastInputAt ? patchStatus(resources, topic, { lastInputAt }) : topic;
}

export function activityWatch(): Watch {
  const parents = (...topics: TopicResource[]) => [...new Map(topics.flatMap(topic =>
    topic.spec.parentRef && !isGateParent(topic.spec.parentRef) ? [topic.spec.parentRef] : [])
    .map(ref => [ref.uid, { name: ref.name, namespace: ref.namespace }])).values()];
  return { resourceType: TOPIC_TYPE, handler: {
    create: async ({ object }) => parents(object as TopicResource),
    delete: async ({ object }) => parents(object as TopicResource),
    update: async ({ oldObject, newObject }) => {
      const a = oldObject as TopicResource, b = newObject as TopicResource;
      return a.status.lastInputAt !== b.status.lastInputAt || a.spec.parentRef?.uid !== b.spec.parentRef?.uid
        || a.metadata.deletionTimestamp !== b.metadata.deletionTimestamp ? parents(a, b) : [];
    },
  } };
}

export function registerTopicObservations(context: PluginContext) {
  context.controllers.register({ name: "activity", resourceType: TOPIC_TYPE, maxConcurrency: 4, watches: [activityWatch()],
    async reconcile(_execution, topic: TopicResource) {
      if (isGateTopic(topic) || topic.metadata.deletionTimestamp) return;
      let updated;
      try { updated = await refreshTopicActivity(context.resources, topic); }
      catch (error) {
        if (/version conflict/.test(String(error))) return { requeueAfterMs: 1 };
        throw error;
      }
      if (updated.metadata.resourceVersion !== topic.metadata.resourceVersion) context.logger.debug("Topic business activity updated", {
        attributes: { topicUid: topic.metadata.uid, lastInputAt: updated.status.lastInputAt! },
      });
    },
  });
}
