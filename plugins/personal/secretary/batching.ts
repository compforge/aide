import type { PluginContext } from "@compforge/aide-plugin";
import { INPUT_TYPE, InputAttention, inputAttention, isInternalInput, type InputSpec, type InputStatus } from "../input/model.ts";
import { type Input } from "../input/state.ts";
import type { TopicResource } from "../topic/model.ts";
import type { TopicPolicy } from "../topic/config.ts";
import { batchKey, unclaimed } from "../batch/members.ts";

import { reconcileBatches } from "../batch/reconcile.ts";
import { prepareBatch } from "../batch/prepare.ts";

/** @spec Membership assignment and readiness commit atomically. Empty preparing resources never enter Chief queues.
 * @spec Count/age preparation is independent of an idle Chief; original attention and authority remain unchanged.
 * @case tests/input-batch.test.ts
 * @link docs/personal/batch.md
 */
export async function prepareInputs(context: Pick<PluginContext, "resources" | "logger">, topic: TopicResource, policy: TopicPolicy, now = Date.now()) {
  await reconcileBatches(context, topic);
  const groups = new Map<string, Input[]>();
  const page = await context.resources.page<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "secretaryPending", value: topic.metadata.uid }, limit: 100 });
  let next = policy.trigger.intervalSeconds * 1000;
  for (const input of page.items) {
    if (!unclaimed(input) || inputAttention(input.spec) !== InputAttention.Deferred || isInternalInput(input.spec) || input.spec.handoff) continue;
    const key = batchKey(input), group = groups.get(key) ?? [];
    group.push(input); groups.set(key, group);
  }
  for (const group of groups.values()) {
    const first = group[0]!, rule = policy.deferred;
    const due = Date.parse(first.metadata.creationTimestamp) + rule.maxWaitSeconds * 1000;
    if (group.length < rule.count && due > now) { next = Math.min(next, due - now); continue; }
    const members = group.slice(0, 10), at = new Date(now).toISOString();
    const batch = await prepareBatch(context, topic, members, at);
    if (!batch) continue;
    context.logger.info("Secretary batch prepared", { attributes: { topicUid: topic.metadata.uid, batchId: batch.metadata.uid, count: members.length,
      oldestAt: first.metadata.creationTimestamp, reason: group.length >= rule.count ? "count" : "age" } });
  }
  return Math.max(1, next);
}
