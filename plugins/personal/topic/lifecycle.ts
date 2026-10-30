import type { PluginContext, ReconcileContext } from "@compforge/aide-plugin";
import { TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "./model.ts";
import { topicPolicy } from "./config.ts";

export async function releaseTopicAgent(context: PluginContext, execution: ReconcileContext, topic: TopicResource) {
  if (!topic.status.agent?.sessionId) return;
  const closed = await execution.verbs.harness({ operation: "close", ...topic.status.agent, sessionId: topic.status.agent.sessionId, timeoutMs: 30_000 });
  if (closed.state !== "success" || closed.value.outcome !== "accepted") throw new Error("Topic agent could not close");
  if (!topic.metadata.deletionTimestamp) {
    const { agent: _, ...status } = topic.status;
    await context.resources.replace(topic, topic.spec, status);
  }
}

/** @spec Silence releases only execution sessions. Topic knowledge remains until safe capacity eviction.
 * @link docs/personal/topic.md#静默回收
 */
export async function collectTopic(context: PluginContext, topic: TopicResource, execution?: ReconcileContext) {
  const delay = { requeueAfterMs: 60_000 };
  if (topic.status.execution) return delay;
  const remaining = Date.parse(topic.status.lastInputAt ?? topic.metadata.creationTimestamp) + topicPolicy(context.instance.config.topic).idleMs - Date.now();
  if (remaining > 0) return { requeueAfterMs: Math.min(remaining, delay.requeueAfterMs) };
  if (execution && topic.status.agent?.sessionId) await releaseTopicAgent(context, execution, topic);
  return delay;
}
