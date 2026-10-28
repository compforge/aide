import { workPhase } from "../status.ts";
import { commitStatus } from "../status.ts";
import { ORGANIZATION_COOLDOWN_MS } from "../weave/config.ts";
import { OrganizationSchema } from "./ref.ts";
import { z } from "zod";
import type { ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { digest } from "../chief-model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { resourceRef } from "../input/state.ts";
import { WORK_TYPES, type WorkResource } from "../resources.ts";
import { TOPIC_TYPE, type TopicResource } from "./model.ts";
import { readTopicSubtree } from "./tree.ts";

const reasonSchema = z.string().trim().min(1).max(2000);
/** @spec Chief reorganizes only its current tree. Version fences cover every observed edge and active execution.
 * @why Concurrent grouping or intake invalidates the whole decision, including a newly detached subtree's responsibility handoff.
 * @link docs/personal/topic.md#归属调整与责任交接
 * @case tests/topic-ownership.test.ts
 */
async function scope(resources: ResourceClient, actor: TopicResource) {
  const topics = await readTopicSubtree(resources, resourceRef(actor));
  const root = topics[0];
  if (!root || root.spec.parentRef || !root.status.execution || root.status.execution.id !== actor.status.execution?.id)
    throw new Error("Organization requires the active root Chief");
  return { root, topics };
}
function fences(topics: TopicResource[], excluded: Set<string> = new Set(), activity?: { topicUid: string; at: string }): ResourceCommit[] {
  const affected = new Set<string>();
  let current = topics.find(t => t.metadata.uid === activity?.topicUid);
  while (current && !affected.has(current.metadata.uid)) {
    affected.add(current.metadata.uid);
    current = topics.find(t => t.metadata.uid === current!.spec.parentRef?.uid);
  }
  return topics.filter(t => !excluded.has(t.metadata.uid)).map(resource => ({ operation: "patchStatus", resource,
    // Carry the evidence's actual age; organizing must never invent new business activity.
    patch: activity && affected.has(resource.metadata.uid)
      ? { lastInputAt: [resource.status.lastInputAt ?? resource.metadata.creationTimestamp, activity.at].sort().at(-1)! } : {} }));
}
export async function createChildTopic(resources: ResourceClient, actor: TopicResource, args: { parentUid?: string; name: string; summary: string; reason: string }, callId: string) {
  const { root, topics } = await scope(resources, actor);
  const parent = topics.find(t => t.metadata.uid === (args.parentUid ?? root.metadata.uid));
  if (!parent || parent.spec.default) throw new Error("Child parent is unavailable or Default");
  const id = `chief-${digest([root.metadata.uid, root.status.execution!.id, callId])}`, name = digest(id);
  const existing = await resources.get<TopicResource["spec"], TopicResource["status"]>({ ...TOPIC_TYPE, namespace: "v1", name });
  if (existing) {
    if (!topics.some(t => t.metadata.uid === existing.metadata.uid)) throw new Error("Created Topic has moved; reread the tree");
    return existing;
  }
  const organization = OrganizationSchema.parse({ at: new Date().toISOString(), reason: args.reason, actorUid: root.metadata.uid, toUid: parent.metadata.uid });
  await commitStatus(resources, [...fences(topics), { operation: "create", type: TOPIC_TYPE, name,
    spec: { id, name: z.string().trim().min(1).max(200).parse(args.name), parentRef: resourceRef(parent) },
    status: { summary: z.string().max(4000).parse(args.summary), recent: [], receipts: [], organization } }]);
  return (await resources.get<TopicResource["spec"], TopicResource["status"]>({ ...TOPIC_TYPE, namespace: "v1", name }))!;
}
export async function moveMaterial(resources: ResourceClient, actor: TopicResource, args: { kind: "Input" | "Task" | "Routine"; id: string; topicUid: string; reason: string }) {
  const { root, topics } = await scope(resources, actor);
  const target = topics.find(t => t.metadata.uid === args.topicUid);
  if (!target) throw new Error("Target Topic is outside this root");
  const type = args.kind === "Input" ? INPUT_TYPE : WORK_TYPES.find(t => t.kind === args.kind)!;
  const material = await resources.get<InputSpec | WorkResource["spec"], InputStatus | WorkResource["status"]>({ ...type, namespace: "v1", name: args.id });
  if (!material || material.metadata.deletionTimestamp || !topics.some(t => t.metadata.uid === material.status.topic?.uid))
    throw new Error("Material is outside this root");
  if (material.status.topic!.uid === target.metadata.uid) return material;
  const organization = OrganizationSchema.parse({ at: new Date().toISOString(), reason: args.reason, actorUid: root.metadata.uid,
    fromUid: material.status.topic!.uid, toUid: target.metadata.uid });
  await commitStatus(resources, [...fences(topics, new Set(), args.kind === "Input" ? { topicUid: target.metadata.uid, at: material.metadata.creationTimestamp } : undefined), { operation: "patchStatus", resource: material, patch: { topic: resourceRef(target), organization } }]);
  return (await resources.get<InputSpec | WorkResource["spec"], InputStatus | WorkResource["status"]>(resourceRef(material)))!;
}
export async function moveTopic(resources: ResourceClient, actor: TopicResource, args: { uid: string; parentUid: string | null; reason: string }) {
  const { root, topics } = await scope(resources, actor);
  const topic = topics.find(t => t.metadata.uid === args.uid);
  const parent = args.parentUid ? topics.find(t => t.metadata.uid === args.parentUid) : undefined;
  if (!topic || topic.metadata.uid === root.metadata.uid || topic.spec.default) throw new Error("Only a descendant may move or become independent");
  if (args.parentUid && (!parent || parent.spec.default)) throw new Error("Parent is outside this root or Default");
  if (topic.spec.parentRef?.uid === parent?.metadata.uid) return topic;
  if (topic.status.organization && topic.status.organization.actorUid !== root.metadata.uid
    && Date.parse(topic.status.organization.at) + ORGANIZATION_COOLDOWN_MS > Date.now())
    throw new Error("Topic organization is cooling down; review its recorded reason before reversing");
  const subtree = await readTopicSubtree(resources, resourceRef(topic));
  if (subtree.some(t => t.metadata.uid === parent?.metadata.uid)) throw new Error("Topic parent cycle");
  const busyInputs = (await Promise.all(subtree.map(t => resources.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "assessPending", value: t.metadata.uid } })))).flat();
  const work = (await Promise.all(subtree.flatMap(t => WORK_TYPES.map(type => resources.list<WorkResource["spec"], import("../work-status.ts").WorkAgentStatus>(type,
    { matchIndex: { name: "topic", value: t.metadata.uid } }))))).flat();
  if (subtree.some(t => t.status.execution) || busyInputs.some(i => i.status.assess?.executionId) || work.some(w => w.status.execution || workPhase(w) === "running"))
    throw new Error("Subtree still has active processing; retry after completion");
  const { parentRef: _, ...spec } = topic.spec;
  const organization = OrganizationSchema.parse({ at: new Date().toISOString(), reason: reasonSchema.parse(args.reason), actorUid: root.metadata.uid,
    fromUid: topic.spec.parentRef?.uid, ...(parent ? { toUid: parent.metadata.uid } : {}) });
  await commitStatus(resources, [...fences(topics, new Set([topic.metadata.uid]), parent ? { topicUid: parent.metadata.uid, at: topic.status.lastInputAt ?? topic.metadata.creationTimestamp } : undefined),
    ...busyInputs.map(resource => ({ operation: "patchStatus" as const, resource, patch: {} })),
    ...work.map(resource => ({ operation: "patchStatus" as const, resource, patch: {} })),
    { operation: "replace", resource: topic, spec: { ...spec, ...(parent ? { parentRef: resourceRef(parent) } : {}) },
      status: { ...topic.status, organization, nextTriggerAt: null, weaveRevision: (topic.status.weaveRevision ?? 0) + 1 } }]);
  return (await resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(topic)))!;
}
