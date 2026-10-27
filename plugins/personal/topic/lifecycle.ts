import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "./model.ts";
import { topicPolicy } from "./config.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { WORK_TYPES, type WorkResource } from "../resources.ts";
import { understandingVersion } from "./tree.ts";

export async function releaseTopicAgent(context: PluginContext, execution: ReconcileContext, topic: TopicResource) {
  if (!topic.status.agent?.sessionId) return;
  const closed = await execution.verbs.harness({ operation: "close", ...topic.status.agent, sessionId: topic.status.agent.sessionId, timeoutMs: 30_000 });
  if (closed.state !== "success" || closed.value.outcome !== "accepted") throw new Error("Topic agent could not close");
  if (!topic.metadata.deletionTimestamp) {
    const { agent: _, ...status } = topic.status;
    await context.resources.replace(topic, topic.spec, status);
  }
}

/** @spec Collect quiet leaves bottom-up. Understanding, pending effects and work must be safe first.
 * @link docs/personal/topic.md
 * @case tests/weave.test.ts
 */
export async function collectTopic(context: PluginContext, topic: TopicResource) {
  const delay = { requeueAfterMs: 60_000 };
  if (topic.spec.default || topic.status.execution) return delay;
  const remaining = Date.parse(topic.status.lastInputAt ?? topic.metadata.creationTimestamp) + topicPolicy(context.instance.config.topic).idleMs - Date.now();
  if (remaining > 0) return { requeueAfterMs: Math.min(remaining, delay.requeueAfterMs) };
  const all = await context.resources.list<TopicSpec, TopicStatus>(TOPIC_TYPE);
  if (all.some(t => t.spec.parentRef?.uid === topic.metadata.uid)) return delay;
  if (topic.spec.parentRef) {
    const parent = all.find(t => t.metadata.uid === topic.spec.parentRef!.uid);
    if (!parent || parent.status.absorbed?.[topic.metadata.uid] !== understandingVersion(topic)) return delay;
  }
  const inputs = await context.resources.list<InputSpec, InputStatus>(INPUT_TYPE);
  if (inputs.some(i => (i.status.route?.result?.topics.some(t => t.uid === topic.metadata.uid) || i.status.assess?.[topic.metadata.uid])
    && Object.values(i.status.assess ?? {}).some(a => !a.completedAt))) return delay;
  const work = (await Promise.all(WORK_TYPES.map(t => context.resources.list<WorkResource["spec"], WorkResource["status"]>(t)))).flat();
  if (work.some(w => w.spec.topicId === topic.spec.id)) return delay;
  await context.resources.delete(TOPIC_TYPE, topic.metadata.name, "v1", { uid: topic.metadata.uid, resourceVersion: topic.metadata.resourceVersion });
  context.logger.info("Quiet Topic deletion requested", { attributes: { topicUid: topic.metadata.uid, topicKey: topic.spec.topicKey ?? null, lastInputAt: topic.status.lastInputAt ?? null } });
  return delay;
}
