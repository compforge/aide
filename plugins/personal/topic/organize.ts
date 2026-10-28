import { commitStatus } from "../status.ts";
import { ORGANIZATION_COOLDOWN_MS } from "../weave/config.ts";
import { OrganizationSchema } from "./ref.ts";
import { z } from "zod";
import type { ResourceClient } from "@compforge/aide-plugin";
import { digest } from "../chief-model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { resourceRef } from "../input/state.ts";
import { WORK_TYPES, type WorkResource } from "../resources.ts";
import { TOPIC_TYPE, type TopicResource } from "./model.ts";
import { readTopicSubtree } from "./tree.ts";

const reasonSchema = z.string().trim().min(1).max(2000);
/** @spec Chief reorganizes only its current tree. Transaction validators check current ancestry and active execution.
 * @why Only changed resources are written; current dependency checks protect responsibility handoff without whole-tree fences.
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
  const organization = OrganizationSchema.parse({ at: new Date().toISOString(), reason: args.reason, actorUid: root.metadata.uid, executionId: root.status.execution!.id, toUid: parent.metadata.uid });
  await commitStatus(resources, [{ operation: "create", type: TOPIC_TYPE, name,
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
  const organization = OrganizationSchema.parse({ at: new Date().toISOString(), reason: args.reason, actorUid: root.metadata.uid, executionId: root.status.execution!.id,
    fromUid: material.status.topic!.uid, toUid: target.metadata.uid });
  await commitStatus(resources, [
    { operation: "patchStatus", resource: material, patch: { topic: resourceRef(target), organization } },
    ...(args.kind === "Input" ? [{ operation: "patchStatus" as const, resource: target,
      patch: { lastInputAt: [target.status.lastInputAt ?? target.metadata.creationTimestamp, material.metadata.creationTimestamp].sort().at(-1)! } }] : []),
  ]);
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
  const { parentRef: _, ...spec } = topic.spec;
  const organization = OrganizationSchema.parse({ at: new Date().toISOString(), reason: reasonSchema.parse(args.reason), actorUid: root.metadata.uid, executionId: root.status.execution!.id,
    fromUid: topic.spec.parentRef?.uid, ...(parent ? { toUid: parent.metadata.uid } : {}) });
  await commitStatus(resources, [
    { operation: "replace", resource: topic, spec: { ...spec, ...(parent ? { parentRef: resourceRef(parent) } : {}) },
      status: { ...topic.status, organization, nextTriggerAt: null, weaveRevision: (topic.status.weaveRevision ?? 0) + 1 } },
    // Notify the old root of changed responsibility and reject admissions prepared against its previous tree.
    { operation: "patchStatus", resource: root, patch: { weaveRevision: (root.status.weaveRevision ?? 0) + 1 } },
  ]);
  return (await resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(topic)))!;
}
