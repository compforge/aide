import { createHash, randomUUID } from "node:crypto";
import type { ResourceClient, ResourceReader, ResourceRef } from "@compforge/aide-plugin";
import { TOPIC_TYPE, initialTopicName, type TopicResource, type TopicSpec, type TopicStatus } from "./model.ts";
import { digest } from "../chief-model.ts";

/** @spec Only parentRef stores hierarchy. Grouping preserves current Input ownership; explicit material moves change status.topic.
 * @link docs/personal/topic.md
 */
export function topicPath(all: readonly TopicResource[], leaf: TopicResource): TopicResource[] {
  const path: TopicResource[] = [];
  let current: TopicResource | undefined = leaf;
  while (current) {
    if (current.metadata.deletionTimestamp || path.some(t => t.metadata.uid === current!.metadata.uid)) throw new Error("Topic path unavailable");
    path.push(current);
    const parent: TopicSpec["parentRef"] = current.spec.parentRef;
    if (!parent) break;
    current = all.find(t => t.metadata.uid === parent.uid && t.metadata.name === parent.name);
    if (!current) throw new Error("Topic parent no longer exists");
  }
  return path;
}
/**
 * @spec Read only descendants reached through the parent index; unrelated Topic trees are never loaded.
 * @why 拓扑排序：按父子依赖逐层广度优先遍历，父节点先于子节点，无需加载全局 Topic。
 * @case tests/topic-tree.test.ts
 * @link docs/personal/topic.md#接纳与连续执行
 */
export function topicSubtree(root: TopicResource, children: (parent: TopicResource) => readonly TopicResource[]): TopicResource[] {
  if (root.metadata.deletionTimestamp) return [];
  const topics = [root], seen = new Set([root.metadata.uid]);
  for (let index = 0; index < topics.length; index++) {
    for (const child of children(topics[index]!)) {
      if (child.metadata.deletionTimestamp || seen.has(child.metadata.uid)) continue;
      seen.add(child.metadata.uid);
      topics.push(child);
    }
  }
  return topics;
}

/** Async Resource API traversal for Runner-side controllers; same parent-first topology as topicSubtree. */
export async function readTopicSubtree(resources: ResourceReader, ref: ResourceRef): Promise<TopicResource[]> {
  const root = await resources.get<TopicSpec, TopicStatus>(ref);
  if (!root || root.metadata.deletionTimestamp) return [];
  const topics = [root], seen = new Set([root.metadata.uid]);
  for (let index = 0; index < topics.length; index++) {
    const parent = topics[index]!;
    const children = await resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE, {
      namespace: parent.metadata.namespace, matchIndex: { name: "parent", value: parent.metadata.uid },
    });
    for (const child of children) {
      if (child.metadata.deletionTimestamp || seen.has(child.metadata.uid)) continue;
      seen.add(child.metadata.uid);
      topics.push(child);
    }
  }
  return topics;
}

/** Resolve wakeups by UID-pinned parent references, without discovering unrelated roots. */
export async function readTopicRoot(resources: ResourceReader, ref: ResourceRef): Promise<TopicResource | undefined> {
  let topic = await resources.get<TopicSpec, TopicStatus>(ref);
  if (topic?.metadata.deletionTimestamp) return;
  const seen = new Set<string>();
  while (topic) {
    if (topic.metadata.deletionTimestamp || seen.has(topic.metadata.uid)) throw new Error("Topic path unavailable");
    seen.add(topic.metadata.uid);
    if (!topic.spec.parentRef) return topic;
    topic = await resources.get<TopicSpec, TopicStatus>(topic.spec.parentRef);
    if (!topic) throw new Error("Topic parent no longer exists");
  }
}
/** @spec A single-target scope check follows only UID-pinned ancestors, never discovers the tree. */
export async function readTopicInScope(resources: ResourceReader, owner: TopicResource, uid = owner.metadata.uid): Promise<TopicResource | undefined> {
  const target = uid === owner.metadata.uid ? owner
    : (await resources.page<TopicSpec, TopicStatus>(TOPIC_TYPE, { limit: 1, matchIndex: { name: "uid", value: uid } })).items[0];
  let current = target;
  const seen = new Set<string>();
  while (current && !current.metadata.deletionTimestamp && !seen.has(current.metadata.uid)) {
    if (current.metadata.uid === owner.metadata.uid) return target;
    seen.add(current.metadata.uid);
    current = current.spec.parentRef ? await resources.get<TopicSpec, TopicStatus>(current.spec.parentRef) : undefined;
  }
}
/** Summary changes drive maintenance; full context versions still fence Weave and deletion. */
export const summaryVersion = (topic: TopicResource): string =>
  createHash("sha256").update(topic.status.summaryRevision ?? "").digest("hex");
export const understandingVersion = (topic: TopicResource, notes: readonly import("../note/model.ts").Note[] = []): string =>
  createHash("sha256").update(JSON.stringify([topic.status.summaryRevision ?? "", notes.map(n => [n.uid, n.version])])).digest("hex");

/** @spec Source identity is reusable; Topic identity is new after expiry. Uniqueness is checked in the storage transaction.
 * @spec A source name initializes a new Topic; later messages never rename an existing Topic or its Weave parent.
 * @case tests/route.test.ts
 * @link docs/personal/topic.md#topiclocator-能力
 */
export async function ensureSourceTopic(resources: ResourceClient, key: string, text: string, name?: string): Promise<TopicResource> {
  const find = async () => (await resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE, { matchIndex: { name: "topicKey", value: key } }))[0];
  const current = await find();
  if (current) return current;
  const id = randomUUID();
  try {
    return await resources.create(TOPIC_TYPE, { name: digest(id), spec: { id, topicKey: key, name: initialTopicName(name?.trim() || text) },
      status: { receipts: [] } });
  } catch (error) {
    if (!String(error).includes("Topic key already exists")) throw error;
    const created = await find();
    if (!created) throw error;
    return created;
  }
}

/** @spec Summary changes can activate parent maintenance. Note-only changes join an already active review.
 * @spec Full context review remains necessary before a child can be reclaimed.
 * @link docs/personal/topic.md#研判与上下文
 */
export function pendingAbsorption(topics: readonly TopicResource[], root: TopicResource, includeNotes = false, versions = new Map<string, string>()) {
  const children = new Map<string, TopicResource[]>();
  for (const topic of topics) if (topic.spec.parentRef) {
    const siblings = children.get(topic.spec.parentRef.uid) ?? [];
    siblings.push(topic);
    children.set(topic.spec.parentRef.uid, siblings);
  }
  const subtree = topicSubtree(root, parent => children.get(parent.metadata.uid) ?? []);
  const byUid = new Map(subtree.map(topic => [topic.metadata.uid, topic]));
  const depths = new Map([[root.metadata.uid, 0]]);
  for (const topic of subtree.slice(1)) depths.set(topic.metadata.uid, depths.get(topic.spec.parentRef!.uid)! + 1);
  return subtree.slice(1)
    .filter(topic => includeNotes
      ? byUid.get(topic.spec.parentRef!.uid)?.status.absorbed?.[topic.metadata.uid] !== (versions.get(topic.metadata.uid) ?? understandingVersion(topic))
      : byUid.get(topic.spec.parentRef!.uid)?.status.absorbedSummaries?.[topic.metadata.uid] !== summaryVersion(topic))
    .sort((a, b) => depths.get(b.metadata.uid)! - depths.get(a.metadata.uid)!)
    .map(topic => ({ uid: topic.metadata.uid, parentUid: topic.spec.parentRef!.uid, version: (versions.get(topic.metadata.uid) ?? understandingVersion(topic)) }));
}
