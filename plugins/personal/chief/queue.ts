import type { ResourceReader } from "@compforge/aide-plugin";
import { INPUT_TYPE, isInternalInput, InputAttention, deliveryFinished, deliveryRetryDue, type InputSpec, type InputStatus } from "../input/model.ts";
import { inputExpired } from "../input/retention.ts";
import type { Input } from "../input/state.ts";
import type { TopicResource } from "../topic/model.ts";
import { isProcessingRoot } from "../topic/boundary.ts";

/** Prepared queue order is shared by initial admission and in-flight delivery. */
export async function preparedInputs(resources: ResourceReader, owner: Readonly<TopicResource>, limit = 10, businessOnly = false, retryDelayMs = 60_000) {
  if (!isProcessingRoot(owner)) return [];
  const result: Input[] = [];
  const queues = [{ name: "assessReadyArrival", value: JSON.stringify([owner.metadata.uid, InputAttention.Immediate]) },
    { name: "assessReadyArrival", value: JSON.stringify([owner.metadata.uid, InputAttention.Normal]) },
    ...(["aide:organize", "aide:followup", "aide:curate", "aide:summary"] as const).map(origin => ({ name: "assessReadyArrival", value: JSON.stringify([owner.metadata.uid, origin]) }))];
  for (const matchIndex of queues) {
    const page = await resources.page<InputSpec, InputStatus>(INPUT_TYPE, { namespace: owner.metadata.namespace, matchIndex, limit: Math.min(10, limit) });
    for (const input of page.items) {
      if (!deliveryRetryDue(input.status.assess, retryDelayMs) || input.metadata.deletionTimestamp || input.status.batchId || inputExpired(input) || deliveryFinished(input.status.assess)
        || input.status.assess?.executionId || result.some(i => i.metadata.uid === input.metadata.uid)) continue;
      const internal = isInternalInput(input.spec);
      if (businessOnly && internal) return result;
      if (internal) return result.length ? result : [input];
      if (result.length && result[0]!.spec.origin !== input.spec.origin) return result;
      result.push(input);
      if (result.length >= limit) return result;
    }
  }
  return result;
}
