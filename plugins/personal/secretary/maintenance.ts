import { reviewAttention } from "./candidate.ts";
import { tryCreateMaintenanceInput } from "./input.ts";
import { digest } from "../identity.ts";
import { isResourceVersionConflict, type PluginContext, type ResourceReader, type ResourceType } from "@compforge/aide-plugin";
import { INPUT_TYPE } from "../input/model.ts";
import { DELEGATED_WORK_TYPES } from "../work/resources.ts";
import { TOPIC_TYPE, type TopicResource } from "../topic/model.ts";
import { topicPolicy } from "../topic/config.ts";

/** Only inspect enough indexed matches to distinguish <= threshold from > threshold. */
async function thresholdCount(resources: ResourceReader, type: ResourceType, name: string, value: string, threshold: number, namespace: TopicResource["metadata"]["namespace"]) {
  let count = 0, token = "";
  const ids: string[] = [];
  do {
    const page = await resources.page(type, { namespace, matchIndex: { name, value }, limit: Math.min(1000, threshold + 1 - count), continue: token });
    count += page.items.length;
    for (const item of page.items) if (ids.length < 8) ids.push(type.kind === "Topic" ? item.metadata.uid : item.metadata.name);
    token = page.metadata.continue;
  } while (token && count <= threshold);
  return { count, ids, truncated: !!token };
}

/** @spec Pressure facts are lower bounds; queries stop at threshold+1, and the agenda stops after eight affected Topics.
 * @why Complete counts and full material bodies are unnecessary to decide whether organization is due.
 * @link docs/personal/secretary.md#容量与维护请求
 * @case tests/topic-ownership.test.ts
 */
export async function maintenanceAgenda(resources: ResourceReader, topics: readonly TopicResource[], config?: unknown) {
  const policy = topicPolicy(config);
  const candidates = [];
  for (const topic of topics) {
    if (topic.metadata.deletionTimestamp) continue;
    const uid = topic.metadata.uid, namespace = topic.metadata.namespace;
    const inputs = await thresholdCount(resources, INPUT_TYPE, "unfiled", uid, policy.maxUnfiledInput, namespace);
    let work = 0, workTruncated = false;
    const workIds: string[] = [];
    for (const type of DELEGATED_WORK_TYPES) {
      if (work > policy.maxWork) { workTruncated = true; break; }
      const result = await thresholdCount(resources, type, "maintenance", uid, policy.maxWork - work, namespace);
      work += result.count; workTruncated ||= result.truncated; workIds.push(...result.ids);
    }
    const child = await thresholdCount(resources, TOPIC_TYPE, "liveParent", uid, policy.maxChildren, namespace);
    const facts = { uid, ...(topic.spec.name ? { name: topic.spec.name.slice(0, 200) } : {}),
      inputs: inputs.count, work, children: child.count,
      truncated: inputs.truncated || workTruncated || child.truncated, inputIds: inputs.ids, workIds: workIds.slice(0, 8), childUids: child.ids };
    if (inputs.count > policy.maxUnfiledInput || work > policy.maxWork || child.count > policy.maxChildren) candidates.push(facts);
    if (candidates.length === 8) break;
  }
  const reason = candidates.length ? "organize_capacity" : "review";
  return { reason, thresholds: { maxUnfiledInput: policy.maxUnfiledInput, maxWork: policy.maxWork, maxChildren: policy.maxChildren },
    affectedTopics: candidates.length, topics: candidates, countsAreLowerBounds: true };
}

/** Every Topic checks only direct capacity; the assigned root performs the requested work. */
export async function observeCapacity(context: PluginContext, topic: TopicResource, policy = topicPolicy(context.instance.config.topic)) {
  const agenda = await maintenanceAgenda(context.resources, [topic], policy);
  const facts = agenda.topics[0];
  const now = Date.now();
  const createdAt = topic.status.organizeSince ?? new Date(now).toISOString();
  try {
    if (!facts && topic.status.organizeSince) await context.resources.patch(topic,
      { type: "json", value: [{ op: "remove", path: "/status/organizeSince" }] }, { resourceVersion: topic.metadata.resourceVersion });
    if (facts && !topic.status.organizeSince) await context.resources.patchStatus(topic, { organizeSince: createdAt }, { resourceVersion: topic.metadata.resourceVersion });
  } catch (error) {
    if (isResourceVersionConflict(error)) return;
    throw error;
  }
  if (!facts) return;
  return { agenda, createdAt };
}

export async function organizationCandidate(context: PluginContext, topic: TopicResource, policy = topicPolicy(context.instance.config.topic)) {
  const observed = await observeCapacity(context, topic, policy);
  if (!observed) return;
  const { agenda, createdAt } = observed;
  const facts = agenda.topics[0]!;
  const attention = reviewAttention(createdAt, policy.review.idleSeconds * 1000, Date.now());
  // One request covers all exceeded limits. Only changes to an active pressure reset its backoff.
  const fingerprint = digest([
    facts.inputs > policy.maxUnfiledInput && [facts.inputs, facts.inputIds, policy.maxUnfiledInput],
    facts.work > policy.maxWork && [facts.work, facts.workIds, policy.maxWork],
    facts.children > policy.maxChildren && [facts.children, facts.childUids, policy.maxChildren],
  ]);
  return { attention, createdAt, dispatch: () => tryCreateMaintenanceInput(context, topic, new Date().toISOString(), agenda, "aide:organize", "capacity", undefined, policy, fingerprint, attention) };
}
