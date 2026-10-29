import type { ResourceClient } from "@compforge/aide-plugin";
import { digest } from "../chief-model.ts";
import { DEFAULT_TOPIC_ID, TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "./model.ts";

/**
 * @spec The system creates one addressless fallback on demand, including concurrent arrivals; it never promotes a user Topic.
 * @link docs/personal/topic.md#默认主题
 * @case tests/default-topic.test.ts
 */
export async function ensureDefaultTopic(resources: ResourceClient): Promise<TopicResource> {
  const name = digest(DEFAULT_TOPIC_ID);
  const key = { ...TOPIC_TYPE, namespace: "v1", name } as const;
  const current = await resources.get<TopicSpec, TopicStatus>(key);
  if (current) return current;
  try {
    return await resources.create<TopicSpec, TopicStatus>(TOPIC_TYPE, {
      name, spec: { id: DEFAULT_TOPIC_ID, name: "Default", default: true }, status: { receipts: [], summary: "" },
    });
  } catch (error) {
    if (!String(error).includes("resource already exists")) throw error;
    const created = await resources.get<TopicSpec, TopicStatus>(key);
    if (!created) throw error;
    return created;
  }
}
