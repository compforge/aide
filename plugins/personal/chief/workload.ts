import type { TopicResource } from "../topic/model.ts";
import type { ReviewEvidence } from "../input/review.ts";
import { chiefWorkload, type ChiefWorkload } from "../topic/workload.ts";

/** @spec Every successful Chief Input or Batch receipt contributes one completion, regardless of origin.
 * @spec Review covers its request snapshot; concurrent completions remain in the next window.
 * @why Review itself counts, but does not start a timed review demand that would perpetuate idle reviews.
 * @case tests/topic-secretary.test.ts
 * @link docs/personal/secretary.md
 */
export function completeChiefWork(topic: Readonly<TopicResource>, at: string, isReview = false, evidence?: ReviewEvidence): ChiefWorkload {
  const previous = chiefWorkload(topic);
  return { ...previous, completed: previous.completed + 1,
    reviewed: Math.max(previous.reviewed, evidence?.completed ?? 0),
    pendingSince: evidence && previous.requestedThrough === evidence.completed
      ? previous.afterRequestSince ?? null : isReview ? previous.pendingSince : previous.pendingSince ?? at,
    ...(!isReview ? { afterRequestSince: previous.afterRequestSince ?? at } : {}),
  };
}
