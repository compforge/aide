import { isRootTopic } from "./boundary.ts";
import { requireTopic } from "./ownership.ts";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { ResourceValidationContext } from "@compforge/aide-plugin";
import type { TopicResource, TopicStatus } from "./model.ts";
import type { TopicReviewPolicy } from "./config.ts";
import type { InputSpec, InputStatus } from "../input/model.ts";
import { reviewEvidence } from "./review-evidence.ts";
import type { NotePressureTopic } from "../note/pressure.ts";

/** Transient preparation used to build task text and atomically reserve cooldowns. */
export interface ReviewPreparation {
  weaveRevision: number;
  absorption: { uid: string; parentUid: string; version: string }[];
  notePressure: NotePressureTopic[];
}

/** Per-Topic opt-in controls background review, independently of Reconcile wakeups and business input. */
export const TopicReviewSchema = z.object({ enabled: z.boolean().default(true) }).strict();
export type TopicReview = z.infer<typeof TopicReviewSchema>;
export const topicReview = (review?: TopicReview): TopicReview => TopicReviewSchema.parse(review ?? {});

export function idleReviewDelay(config: TopicReviewPolicy, count = 0): number {
  return 1000 * (config.backoff
    ? Math.min(config.idleSeconds * config.backoff.factor ** count, config.backoff.maxIdleSeconds)
    : config.idleSeconds);
}

/**
 * @spec Review eligibility derives from durable timing facts and the current policy; periodic Reconcile wakeups have no business deadline.
 * @spec The first observed business arrival resets backoff without postponing an earlier review; later arrivals retain that boundary.
 * @why Keeping the pre-reset count and arrival time lets both deadlines be recalculated after policy changes, without restarting the wait.
 * @case tests/topic-review.test.ts
 * @link docs/personal/topic.md#topic-定时回顾
 */
export function idleReviewSchedule(topic: Readonly<TopicResource>, config: TopicReviewPolicy) {
  const status = topic.status;
  const since = status.reviewCheckedAt ?? status.idleSince ?? topic.metadata.creationTimestamp;
  const enabled = isRootTopic(topic) && !topic.metadata.deletionTimestamp && topicReview(topic.spec.review).enabled;
  let reset = enabled && config.backoff ? status.idleReviewReset ?? null : null;
  if (reset && reset.at <= since) reset = null;
  if (enabled && config.backoff && !reset && status.lastInputAt && status.lastInputAt > since)
    reset = { at: status.lastInputAt, previousCount: status.idleReviewCount ?? 0 };
  const count = enabled && config.backoff && !reset ? status.idleReviewCount ?? 0 : 0;
  const dueAt = new Date(Math.min(Date.parse(since) + idleReviewDelay(config, reset?.previousCount ?? count),
    reset ? Date.parse(reset.at) + config.idleSeconds * 1000 : Infinity)).toISOString();
  const patch: Partial<TopicStatus> = {};
  if ((status.idleReviewCount ?? 0) !== count) patch.idleReviewCount = count;
  if (!isDeepStrictEqual(status.idleReviewReset ?? null, reset)) patch.idleReviewReset = reset;
  return { dueAt, count, patch };
}

/** @spec Internal request admission checks current Topic identity and eligibility inside the creation transaction.
 * @case tests/note-knowledge.test.ts
 */
export function validateReviewRequest(input: { spec: InputSpec; status: InputStatus }, context: ResourceValidationContext) {
  reviewEvidence(input.spec);
  const topic = requireTopic(input.status.topic, context);
  if (input.spec.originRef?.uid !== topic.metadata.uid) throw new Error("Internal Input target changed");
  if (input.spec.origin === "aide:review" && (!isRootTopic(topic) || (!topicReview(topic.spec.review).enabled && !["understanding", "note_pressure"].includes(String(input.spec.observation?.trigger)))))
    throw new Error("Review requires an eligible root Topic");
}
