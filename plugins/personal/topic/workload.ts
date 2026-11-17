import { z } from "zod";
import type { TopicResource } from "./model.ts";
import type { ReviewEvidence } from "./review-evidence.ts";

export const ChiefWorkloadSchema = z.object({
  completed: z.number().int().nonnegative(), reviewed: z.number().int().nonnegative(),
  pendingSince: z.string().datetime().nullable().optional(),
  requestedThrough: z.number().int().nonnegative().optional(),
  afterRequestSince: z.string().datetime().nullable().optional(),
}).strict();
export type ChiefWorkload = z.infer<typeof ChiefWorkloadSchema>;
export const chiefWorkload = (topic: Readonly<TopicResource>): ChiefWorkload => topic.status.chiefWorkload
  ?? { completed: 0, reviewed: 0, pendingSince: null };

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
