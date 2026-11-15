import { isGateTopic } from "../topic/boundary.ts";
import type { ResourceClient } from "@compforge/aide-plugin";
import { digest } from "../chief-model.ts";
import { GATE_TOPIC_ID, TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "../topic/model.ts";

/** @spec Gate is a persistent singleton conversation and global tree root; domain children keep independent ownership.
 * @link docs/personal/gate.md
 */
export async function ensureGateTopic(resources: ResourceClient): Promise<TopicResource> {
  const name = digest(GATE_TOPIC_ID), ref = { ...TOPIC_TYPE, namespace: "v1" as const, name };
  const existing = await resources.get<TopicSpec, TopicStatus>(ref);
  if (existing) {
    if (!isGateTopic(existing) || existing.metadata.deletionTimestamp) throw new Error("Reserved Gate identity is occupied");
    return existing;
  }
  try {
    return await resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, {
      name, spec: { id: GATE_TOPIC_ID, name: "Gate", review: { enabled: false } }, status: { receipts: [] },
    });
  } catch (error) {
    if (!String(error).includes("resource already exists")) throw error;
    const created = await resources.get<TopicSpec, TopicStatus>(ref);
    if (!created || !isGateTopic(created) || created.metadata.deletionTimestamp) throw error;
    return created;
  }
}
