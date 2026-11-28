import { isProcessingRoot, isGateParent } from "./boundary.ts";
import { isDeepStrictEqual } from "node:util";
import { INPUT_TYPE } from "../input/model.ts";
import { readTopicRoot } from "./tree.ts";
import { resourceRef } from "../input/state.ts";
import type { PluginContext, Watch } from "@compforge/aide-plugin";
import { TOPIC_TYPE, type TopicResource } from "./model.ts";

export function topicWatch(context: PluginContext): Watch {
  const rootRequests = async (topic: TopicResource, previous?: TopicResource) => {
    const refs = [!isProcessingRoot(topic) && topic.spec.parentRef ? topic.spec.parentRef : resourceRef(topic), ...(previous?.spec.parentRef && !isGateParent(previous.spec.parentRef) ? [previous.spec.parentRef] : [])];
    const roots = await Promise.all(refs.map(ref => readTopicRoot(context.resources, ref)));
    return [...new Map([topic, ...(await Promise.all(refs.map(ref => context.resources.get<TopicResource["spec"], TopicResource["status"]>(ref)))), ...roots].filter((r): r is TopicResource => !!r).map(r => [r.metadata.uid, { name: r.metadata.name, namespace: r.metadata.namespace }])).values()];
  };
  return { resourceType: TOPIC_TYPE, handler: {
    create: async ({ object }) => rootRequests(object as TopicResource),
    delete: async ({ object }) => rootRequests(object as TopicResource),
    update: async ({ oldObject, newObject }) => {
      const a = oldObject as TopicResource, b = newObject as TopicResource;
      if (a.spec.parentRef?.uid !== b.spec.parentRef?.uid || a.status.weaveRevision !== b.status.weaveRevision
        || !isDeepStrictEqual(a.status.notePressure, b.status.notePressure)
        || a.metadata.deletionTimestamp !== b.metadata.deletionTimestamp) return rootRequests(b, a);
      return a.status.execution?.id !== b.status.execution?.id || a.status.lastInputAt !== b.status.lastInputAt
        || a.status.chiefWorkload?.completed !== b.status.chiefWorkload?.completed
        ? [{ name: b.metadata.name, namespace: b.metadata.namespace }] : [];
    } } };
}
export function materialWatch(): Watch {
  const requests = (...inputs: Array<import("../input/state.ts").Input | undefined>) => inputs.flatMap(i =>
    i?.status.topic ? [{ name: i.status.topic.name, namespace: i.status.topic.namespace }] : []);
  return { resourceType: INPUT_TYPE, handler: {
    create: async ({ object }) => requests(object as import("../input/state.ts").Input),
    delete: async ({ object }) => requests(object as import("../input/state.ts").Input),
    update: async ({ oldObject, newObject }) => {
      const a = oldObject as import("../input/state.ts").Input, b = newObject as import("../input/state.ts").Input;
      return a.status.topic?.uid !== b.status.topic?.uid || a.metadata.deletionTimestamp !== b.metadata.deletionTimestamp
        || a.status.assess?.lastError !== b.status.assess?.lastError || a.status.assess?.completedAt !== b.status.assess?.completedAt ? requests(a, b) : [];
    },
  } };
}
