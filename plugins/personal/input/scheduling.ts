import { isProcessingRoot } from "../topic/boundary.ts";
import { inputExpired } from "./retention.ts";
import type { ResourceReader } from "@compforge/aide-plugin";
import { INPUT_TYPE, InputAttention, type InputSpec, type InputStatus } from "./model.ts";
import type { Input } from "./state.ts";
import type { TopicResource } from "../topic/model.ts";
import { topicPolicy, type TopicPolicy } from "../topic/config.ts";

/** @spec Count or oldest arrival promotes a root's deferred backlog to normal scheduling without changing authority or stored attention.
 * @spec Selection reads at most ten indexed oldest deferred Inputs; promotion needs no new Input or quota slot.
 * @spec A running Chief admits at most one outstanding deferred batch; Immediate and Normal admission remain independent.
 * @link docs/personal/input.md#内容身份与调度
 * @case tests/topic-attention.test.ts
 */
export async function readyBusinessInputs(resources: ResourceReader, owner: Readonly<TopicResource>, policy: TopicPolicy = topicPolicy(), now = Date.now()) {
  const inputs: Input[] = [];
  if (!isProcessingRoot(owner)) return { inputs };
  const page = (attention: InputAttention, limit: number) => resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
    namespace: owner.metadata.namespace, matchIndex: { name: "assessReadyArrival", value: JSON.stringify([owner.metadata.uid, attention]) }, limit,
  });
  for (const attention of [InputAttention.Immediate, InputAttention.Normal]) {
    inputs.push(...(await page(attention, 10 - inputs.length)).items.filter(i => !inputExpired(i, now)));
    if (inputs.length === 10) return { inputs };
  }
  // Do not enqueue thousands of old facts behind one running model turn. Completion wakes intake for the next batch.
  if (owner.status.execution && (await resources.page<InputSpec, InputStatus>(INPUT_TYPE, {
    namespace: owner.metadata.namespace, matchIndex: { name: "assessDeferredExecution", value: owner.status.execution.id }, limit: 1,
  })).items.length) return { inputs };
  const deferred = (await page(InputAttention.Deferred, 10)).items.filter(i => !inputExpired(i, now));
  const oldestAt = deferred[0]?.metadata.creationTimestamp;
  const reason = deferred.length >= policy.deferred.count ? "count"
    : oldestAt && Date.parse(oldestAt) + policy.deferred.maxWaitSeconds * 1000 <= now ? "age" : undefined;
  if (inputs.length || reason) inputs.push(...deferred.slice(0, 10 - inputs.length));
  return { inputs, reason, oldestAt };
}
