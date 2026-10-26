import { createHash, randomUUID } from "node:crypto";
import type { ResourceClient } from "@compforge/aide-plugin";
import { TOPIC_TYPE, initialTopicName, type TopicResource, type TopicSpec, type TopicStatus } from "./model.ts";
import { digest } from "../chief-model.ts";

/** @spec Only parentRef stores hierarchy. Input binding stays at its original Topic across grouping.
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
export function topicSubtree(all: readonly TopicResource[], root: TopicResource): TopicResource[] {
  return all.filter(t => !t.metadata.deletionTimestamp && topicPath(all, t).some(p => p.metadata.uid === root.metadata.uid));
}
export const understandingVersion = (topic: TopicResource): string =>
  createHash("sha256").update(JSON.stringify([topic.status.summary, topic.status.recent])).digest("hex");

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
      status: { receipts: [], summary: "", recent: [] } });
  } catch (error) {
    if (!String(error).includes("Topic key already exists")) throw error;
    const created = await find();
    if (!created) throw error;
    return created;
  }
}

/** @spec Unabsorbed child versions are derived work. Leaf knowledge propagates bottom-up without new external Input. */
export function pendingAbsorption(all: readonly TopicResource[], root: TopicResource) {
  return topicSubtree(all, root).filter(t => t.spec.parentRef && !t.status.weaveLock)
    .filter(t => all.find(p => p.metadata.uid === t.spec.parentRef!.uid)?.status.absorbed?.[t.metadata.uid] !== understandingVersion(t))
    .sort((a, b) => topicPath(all, b).length - topicPath(all, a).length)
    .map(t => ({ uid: t.metadata.uid, parentUid: t.spec.parentRef!.uid, version: understandingVersion(t) }));
}
