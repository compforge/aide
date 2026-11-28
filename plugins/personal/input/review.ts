import { SubjectSchema } from "../note/model.ts";
import { BATCH_TYPE } from "../batch/model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "./model.ts";
import { topicSubtree } from "../topic/tree.ts";
import { TOPIC_TYPE, type TopicResource } from "../topic/model.ts";
import { z } from "zod";
import { requireTopic } from "../topic/ownership.ts";
import { isRootTopic } from "../topic/boundary.ts";
import { topicReview } from "../topic/review.ts";
import { ResourceVersionConflict, type ResourceValidationContext } from "@compforge/aide-plugin";

export const SummaryOwnerSchema = SubjectSchema.extend({ kind: z.enum(["Topic", "Person", "Address"]) });

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
export function validateReviewRequest(input: { metadata: { name: string }; spec: InputSpec; status: InputStatus }, context: ResourceValidationContext) {
  reviewEvidence(input.spec);
  const topic = requireTopic(input.status.topic, context);
  if (input.spec.originRef?.uid !== topic.metadata.uid) throw new Error("Internal Input target changed");
  if (input.spec.origin === "aide:stow" && (!isRootTopic(topic) || topic.status.execution
    || !topic.status.agent?.sessionId || topic.status.agent.sessionId !== input.spec.observation?.sessionId
    || topic.status.agent.promptTokens !== input.spec.observation?.promptTokens)) throw new ResourceVersionConflict("Stow observation has changed");
  if (input.spec.origin === "aide:summary") {
    const ref = SummaryOwnerSchema.parse(input.spec.observation?.summaryOwner);
    const owner = context.get(ref, ref.uid);
    if (!owner || owner.metadata.name !== ref.name || owner.metadata.deletionTimestamp || !isRootTopic(topic))
      throw new Error("Summary review owner or domain unavailable");
    if (ref.kind === "Topic") {
      let root = requireTopic(ref, context);
      while (root.spec.parentRef && !isRootTopic(root)) root = requireTopic(root.spec.parentRef, context);
      if (root.metadata.uid !== topic.metadata.uid) throw new Error("Summary review Topic moved");
    } else if (!topic.spec.default) throw new Error("Shared Summary reviews belong to the default Chief");
    // The indexes and execution are read in the same transaction that hands the Input to Chief.
    const queued = (name: string, uid: string) => context.list<InputSpec, InputStatus>(INPUT_TYPE, { matchIndex: { name, value: uid } })
      .some(other => other.metadata.name !== input.metadata.name && other.spec.origin !== "aide:stow");
    const children = (parent: TopicResource) => context.list<TopicResource["spec"], TopicResource["status"]>(TOPIC_TYPE,
      { matchIndex: { name: "parent", value: parent.metadata.uid } });
    if (topic.status.execution || queued("assignedPending", topic.metadata.uid)
      || context.list(BATCH_TYPE, { matchIndex: { name: "open", value: topic.metadata.uid } }).length
      || topicSubtree(topic, children).some(child => queued("unassigned", child.metadata.uid)))
      throw new Error("Chief has queued work");
  }
  if (input.spec.origin === "aide:curate" && (!isRootTopic(topic) || (!topicReview(topic.spec.review).enabled && !["understanding", "note_pressure", "notes_changed"].includes(String(input.spec.observation?.trigger)))))
    throw new Error("Review requires an eligible root Topic");
}
