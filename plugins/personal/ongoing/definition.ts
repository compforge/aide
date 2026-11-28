import type { ResourceDefinition, ResourceValidationContext } from "@compforge/aide-plugin";
import { equalResourceValue } from "../../../src/resource/value.ts";
import { requireContentWriter } from "../context-write.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { requireProcessingRoot, requireTopic } from "../topic/ownership.ts";
import { nextCheckAfterRetention, nextCheckAfterDelivery, ONGOING_TYPE, OngoingSpecSchema, OngoingStatusSchema, followupInputId, type OngoingResource, type OngoingSpec, type OngoingStatus } from "./model.ts";

function validateMatter(matter: OngoingResource, context: ResourceValidationContext) {
  if (matter.metadata.namespace !== "v1" || matter.metadata.owner || matter.metadata.deletionTimestamp)
    throw new Error("Ongoing requires an independent domain resource");
  if (matter.status.closure && (matter.status.nextCheckAt || matter.spec.question)) throw new Error("Closed Ongoing cannot schedule checks");
  requireContentWriter(requireTopic(matter.spec.topic, context), matter.status.writer, context);
}

/** @spec The emitted reminder and its scheduling receipt commit together.
 * @link docs/personal/work.md#ongoing
 */
export const OngoingDefinition: ResourceDefinition<OngoingSpec, OngoingStatus> = {
  type: ONGOING_TYPE, schema: { spec: OngoingSpecSchema, status: OngoingStatusSchema },
  validator: {
    create(matter, context) {
      if (matter.status.followupInputId || matter.status.closure || !matter.status.nextCheckAt)
        throw new Error("New Ongoing requires an open initial plan");
      validateMatter(matter, context);
    },
    update(before, after, context) {
      // A version precondition protects related Input and Output writes without a new business decision.
      if (equalResourceValue(before.spec, after.spec) && equalResourceValue(before.status, after.status)) return;
      // Delivery and its next default appointment share the same transaction, including crash recovery.
      if (before.status.followupInputId && !after.status.followupInputId && !before.status.closure) {
        const receipt = context.page<InputSpec, InputStatus>(INPUT_TYPE, { limit: 1,
          matchIndex: { name: "followup", value: before.status.followupInputId } }).items[0];
        const deliveredAt = receipt?.status.assess?.completedAt;
        const nextCheckAt = receipt ? deliveredAt && nextCheckAfterDelivery(before, receipt, deliveredAt) : nextCheckAfterRetention(before);
        if (nextCheckAt && equalResourceValue(before.spec, after.spec) && equalResourceValue({ ...after.status, followupInputId: undefined },
          { ...before.status, followupInputId: undefined, nextCheckAt })) return;
      }
      const id = followupInputId(before);
      if (after.status.followupInputId && before.status.followupInputId !== after.status.followupInputId) {
        const input = id && context.page<InputSpec, InputStatus>(INPUT_TYPE, { limit: 1, matchIndex: { name: "followup", value: id } }).items[0];
        if (!input || before.status.followupInputId || input.spec.observation?.dueAt !== before.status.nextCheckAt || input.spec.observation?.ongoingUid !== before.metadata.uid || id !== after.status.followupInputId
          || input.status.topic?.uid !== requireProcessingRoot(before.spec.topic, context).metadata.uid
          || !equalResourceValue(before.spec, after.spec) || !equalResourceValue({ ...before.status, followupInputId: id }, after.status))
          throw new Error("Ongoing check receipt must match the scheduled Input");
        return;
      }
      if (before.status.closure || !equalResourceValue(before.spec.topic, after.spec.topic)
        || before.spec.initialInputId !== after.spec.initialInputId || before.spec.sourceUid !== after.spec.sourceUid)
        throw new Error("Ongoing is closed or its origin changed");
      const revised = before.status.nextCheckAt !== after.status.nextCheckAt || before.spec.question !== after.spec.question || !!after.status.closure;
      if (after.status.followupInputId !== (revised ? undefined : before.status.followupInputId))
        throw new Error("Ongoing check receipt must follow the scheduled check");
      validateMatter(after, context);
    },
    delete(matter) { if (!matter.status.closure) throw new Error("Close Ongoing before deletion"); },
  },
  indexes: { topic: r => [r.spec.topic.uid], openTopic: r => !r.status.closure && !r.metadata.deletionTimestamp ? [r.spec.topic.uid] : [] },
  retention: { releasedAt: r => r.status.closure?.at, canEvict: r => !!r.status.closure, references: () => [] },
  printer: { summarize: r => r.spec.title, describe: r => [r.spec.title, r.status.progress, r.status.closure?.outcome].filter(Boolean).join("\n") },
};
