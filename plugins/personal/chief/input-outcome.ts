import type { Input } from "../input/state.ts";
import type { TopicResource, TopicStatus } from "../topic/model.ts";
import { reviewEvidence } from "../input/review.ts";
import { completeChiefWork } from "./workload.ts";

/** @spec Completion facts commit with the Input receipt, without a second Secretary acknowledgement.
 * @case tests/topic-secretary.test.ts
 */
export function inputOutcome(input: Input, owner: TopicResource, at: string): Partial<TopicStatus> {
  if (input.spec.origin === "aide:stow") return {};
  const evidence = input.spec.originRef?.uid === owner.metadata.uid ? reviewEvidence(input.spec) : undefined;
  return { chiefWorkload: completeChiefWork(owner, at, input.spec.origin === "aide:curate" || input.spec.origin === "aide:summary", evidence),
    ...(evidence ? { notifiedWeaveRevision: Math.max(owner.status.notifiedWeaveRevision ?? 0, evidence.weaveRevision) } : {}),
  };
}
