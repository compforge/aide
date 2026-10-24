import { ensureDefaultTopic } from "../topic/default.ts";
import { digest } from "../chief-model.ts";
import { DEFAULT_TOPIC_ID, TOPIC_TYPE, initialTopicName, type TopicSpec, type TopicStatus } from "../topic/model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { deliver, routed, type RoutingContext, type RoutingInput } from "./delivery.ts";
import type { Destination } from "./model.ts";
import { ensureSourceTopic } from "../topic/tree.ts";

/**
 * @spec Lark topics create/reuse their Topic directly; other inputs may inherit original-input destinations.
 * @spec Without any live non-Default candidate, fallback is deterministic; explicit topic creation takes precedence.
 * @link docs/personal/route.md
 * @link docs/connector/lark-messages.md#topic-创建与归属
 * @case tests/route.test.ts
 */
export async function routeByRules(context: RoutingContext, original: RoutingInput): Promise<boolean> {
  const input = (await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, ...original.metadata }))!;
  if (routed(input)) return true;
  if (input.spec.topicKey) {
    const topic = await ensureSourceTopic(context.resources, input.spec.topicKey, input.spec.text);
    await deliver(context, input, [topic.metadata], "Source topic key");
    return true;
  }
  const topics = (await context.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE)).filter(c => !c.metadata.deletionTimestamp);
  const destinations = new Map<string, Destination>();
  if (input.spec.topicId) {
    let topic = input.spec.topicId === DEFAULT_TOPIC_ID ? await ensureDefaultTopic(context.resources) : topics.find(t => t.spec.id === input.spec.topicId);
    if (!topic && input.spec.origin === "channel") {
      try {
        topic = await context.resources.create(TOPIC_TYPE, { name: digest(input.spec.topicId),
          spec: { id: input.spec.topicId, name: initialTopicName(input.spec.text), ...(input.spec.source ? { address: input.spec.source } : {}) },
          status: { receipts: [], summary: "", recent: [] } });
      } catch (error) {
        if (!String(error).includes("resource already exists")) throw error;
        topic = await context.resources.get<TopicSpec, TopicStatus>({ ...TOPIC_TYPE, namespace: "v1", name: digest(input.spec.topicId) });
      }
    }
    if (!topic || topic.metadata.deletionTimestamp || topic.status.weaveLock === topic.spec.id) throw new Error("Explicit Topic unavailable");
    destinations.set(topic.metadata.uid, topic.metadata);
  }
  const originalId = input.spec.observation?.originalInputId;
  if (!destinations.size && typeof originalId === "string" && originalId !== input.metadata.name) {
    const preceding = await context.resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: originalId });
    for (const c of topics) if (preceding?.status.route?.result?.topics.some(ref => ref.uid === c.metadata.uid)) { destinations.set(c.metadata.uid, c.metadata); break; }
  }
  if (!destinations.size) {
    if (topics.some(c => !c.spec.default && !c.spec.parentRef)) return false;
    await deliver(context, input, [await defaultDestination(context)], "No non-Default Topic candidates");
    return true;
  }
  await deliver(context, input, [...destinations.values()].map(({ name, uid }) => ({ name, uid })), "Deterministic topic or original Input");
  return true;
}

/** @spec Unmatched inputs always have a durable fallback; an observed address is never adopted as its reply address. */
export async function defaultDestination(context: RoutingContext): Promise<Destination> {
  const topic = await ensureDefaultTopic(context.resources);
  return { name: topic.metadata.name, uid: topic.metadata.uid };
}
