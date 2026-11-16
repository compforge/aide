import type { ResourceReader } from "@compforge/aide-plugin";
import { INPUT_TYPE, InputAttention, assessmentFinished, type InputSpec, type InputStatus } from "./model.ts";
import { inputExpired } from "./retention.ts";
import type { Input } from "./state.ts";
import type { TopicResource } from "../topic/model.ts";
import { isProcessingRoot } from "../topic/boundary.ts";
import type { TopicPolicy } from "../topic/config.ts";

/** Prepared queue order is shared by initial admission and in-flight delivery. */
export async function preparedInputs(resources: ResourceReader, owner: Readonly<TopicResource>, limit = 10, businessOnly = false) {
  if (!isProcessingRoot(owner)) return [];
  const result: Input[] = [];
  const active = await resources.page<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name: "batchActive", value: owner.metadata.uid }, limit: 1 });
  const queues = [{ name: "assessReadyArrival", value: JSON.stringify([owner.metadata.uid, InputAttention.Immediate]) },
    { name: "promotedReady", value: owner.metadata.uid },
    { name: "assessReadyArrival", value: JSON.stringify([owner.metadata.uid, InputAttention.Normal]) },
    ...(["aide:triage", "aide:organize", "aide:review"] as const).map(origin => ({ name: "assessReadyArrival", value: JSON.stringify([owner.metadata.uid, origin]) }))];
  for (const matchIndex of queues) {
    const previousCount = result.length;
    const page = await resources.page<InputSpec, InputStatus>(INPUT_TYPE, { namespace: owner.metadata.namespace, matchIndex, limit: Math.min(10, limit) });
    for (const input of page.items) {
      if (input.metadata.deletionTimestamp || input.status.batch || inputExpired(input) || assessmentFinished(input.status.assess)
        || input.status.assess?.executionId || result.some(i => i.metadata.uid === input.metadata.uid)) continue;
      if ((input.spec.batch || input.status.promotedAt) && input.spec.attention !== InputAttention.Immediate && active.items.length) continue;
      const internal = input.spec.origin.startsWith("aide:");
      if (businessOnly && internal) return result;
      if (internal || input.spec.batch) return result.length ? result : [input];
      if (result.length && result[0]!.spec.origin !== input.spec.origin) return result;
      result.push(input);
      if (result.length >= limit) return result;
    }
    if (matchIndex.name === "promotedReady" && result.length > previousCount) return result;
  }
  return result;
}
export async function readyBusinessInputs(resources: ResourceReader, owner: Readonly<TopicResource>, _policy?: TopicPolicy, _now?: number) {
  return { inputs: await preparedInputs(resources, owner, 10, true), reason: undefined, oldestAt: undefined };
}
