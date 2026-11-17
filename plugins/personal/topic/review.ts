import { z } from "zod";

/** Per-Topic opt-in controls background review, independently of Reconcile wakeups and business input. */
export const TopicReviewSchema = z.object({ enabled: z.boolean().default(true) }).strict();
export type TopicReview = z.infer<typeof TopicReviewSchema>;
export const topicReview = (review?: TopicReview): TopicReview => TopicReviewSchema.parse(review ?? {});
