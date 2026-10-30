import { createReviewInput } from "./review.ts";
import { resourceRef, inputRef } from "../input/state.ts";
import type { InputSpec, InputStatus } from "../input/model.ts";
import type { ResourceReader, ResourceType } from "@compforge/aide-plugin";
import { INPUT_TYPE } from "../input/model.ts";
import { WORK_TYPES } from "../resources.ts";
import { TOPIC_TYPE, type TopicResource } from "./model.ts";
import { topicPolicy } from "./config.ts";

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
 * @link docs/personal/topic.md#树内整理与维护优先级
 * @case tests/topic-ownership.test.ts
 */
export async function maintenanceAgenda(resources: ResourceReader, topics: readonly TopicResource[], config?: unknown) {
  const policy = topicPolicy(config);
  const material = [], children = [];
  for (const topic of topics) {
    if (topic.metadata.deletionTimestamp) continue;
    const uid = topic.metadata.uid, namespace = topic.metadata.namespace;
    const inputs = await thresholdCount(resources, INPUT_TYPE, "unfiled", uid, policy.maxUnfiledInput, namespace);
    let work = 0, workTruncated = false;
    for (const type of WORK_TYPES) {
      if (work > policy.maxWork) { workTruncated = true; break; }
      const result = await thresholdCount(resources, type, "maintenance", uid, policy.maxWork - work, namespace);
      work += result.count; workTruncated ||= result.truncated;
    }
    const child = await thresholdCount(resources, TOPIC_TYPE, "liveParent", uid, policy.maxChildren, namespace);
    const facts = { uid, ...(topic.spec.name ? { name: topic.spec.name.slice(0, 200) } : {}),
      inputs: inputs.count, work, children: child.count,
      truncated: inputs.truncated || workTruncated || child.truncated, inputIds: inputs.ids, childUids: child.ids };
    if (inputs.count > policy.maxUnfiledInput || work > policy.maxWork) material.push(facts);
    else if (child.count > policy.maxChildren && children.length < 8) children.push(facts);
    if (material.length === 8) break;
  }
  const reason = material.length ? "organize_material" : children.length ? "organize_children" : "review";
  const candidates = material.length ? material : children;
  return { reason, thresholds: { maxUnfiledInput: policy.maxUnfiledInput, maxWork: policy.maxWork, maxChildren: policy.maxChildren },
    affectedTopics: candidates.length, topics: candidates, countsAreLowerBounds: true };
}

/** Every Topic checks only direct capacity; the assigned root performs the requested work. */
export async function ensureCapacityInputs(context: import("@compforge/aide-plugin").PluginContext, topic: TopicResource) {
  const policy = topicPolicy(context.instance.config.topic);
  const agenda = await maintenanceAgenda(context.resources, [topic], policy);
  const facts = agenda.topics[0];
  if (!facts) return;
  for (const origin of ["aide:triage", "aide:organize"] as const) {
    const needed = origin === "aide:triage" ? facts.inputs > policy.maxUnfiledInput || facts.work > policy.maxWork : facts.children > policy.maxChildren;
    if (!needed) continue;
    const current = await context.resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(topic));
    if (!current || current.metadata.deletionTimestamp) return;
    const previous = current.status.capacityRequests?.[origin];
    if (previous) {
      const input = await context.resources.get<InputSpec, InputStatus>(inputRef(previous.inputId));
      if (input && !input.status.assess?.completedAt) continue;
      const since = input?.status.assess?.completedAt ?? previous.checkedAt;
      if (Date.parse(since) + policy.capacityCooldownSeconds * 1000 > Date.now()) continue;
    }
    await createReviewInput(context, current, new Date().toISOString(), agenda, origin);
  }
}
