import { z } from "zod";
import type { InputSpec } from "../input/model.ts";

/** Immutable trigger identities for review deduplication; scheduling state belongs to Topic.
 * @why A successful no-op acknowledges only the requested versions, never newer observations.
 */
export const ReviewEvidenceSchema = z.object({ materialVersion: z.string(), weaveRevision: z.number().int().nonnegative(),
  pressure: z.array(z.object({ uid: z.string(), version: z.string() }).strict()).max(8) }).strict();
export type ReviewEvidence = z.infer<typeof ReviewEvidenceSchema>;
export function reviewEvidence(spec: InputSpec): ReviewEvidence | undefined {
  return spec.origin === "aide:review" && spec.originId === "personal.topic" && spec.observation?.review !== undefined
    ? ReviewEvidenceSchema.parse(spec.observation.review) : undefined;
}
