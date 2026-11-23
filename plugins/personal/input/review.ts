import { z } from "zod";
import type { InputSpec } from "./model.ts";
import { requireTopic } from "../topic/ownership.ts";
import { isRootTopic } from "../topic/boundary.ts";
import { topicReview } from "../topic/review.ts";
import type { ResourceValidationContext } from "@compforge/aide-plugin";
import type { InputStatus } from "./model.ts";

/** Immutable trigger identities for review deduplication; scheduling state belongs to Topic.
 * @why A successful no-op acknowledges only the requested versions, never newer observations.
 */
export const ReviewEvidenceSchema = z.object({ completed: z.number().int().nonnegative(), weaveRevision: z.number().int().nonnegative(),
  pressure: z.array(z.object({ uid: z.string(), version: z.string() }).strict()).max(8) }).strict();
export type ReviewEvidence = z.infer<typeof ReviewEvidenceSchema>;
export function reviewEvidence(spec: InputSpec): ReviewEvidence | undefined {
  return spec.origin === "aide:curate" && spec.originId === "personal.topic" && spec.observation?.review !== undefined
    ? ReviewEvidenceSchema.parse(spec.observation.review) : undefined;
}


/** @spec Internal request admission checks current Topic identity and eligibility inside the creation transaction.
 * @case tests/note-knowledge.test.ts
 */
export function validateReviewRequest(input: { spec: InputSpec; status: InputStatus }, context: ResourceValidationContext) {
  reviewEvidence(input.spec);
  const topic = requireTopic(input.status.topic, context);
  if (input.spec.originRef?.uid !== topic.metadata.uid) throw new Error("Internal Input target changed");
  if (input.spec.origin === "aide:curate" && (!isRootTopic(topic) || (!topicReview(topic.spec.review).enabled && !["understanding", "note_pressure", "unclassified", "summary_conflict"].includes(String(input.spec.observation?.trigger)))))
    throw new Error("Review requires an eligible root Topic");
}
