import { ResourceRefSchema } from "../topic/ref.ts";
import type { ResourceDefinition, ResourceValidationContext } from "@compforge/aide-plugin";
import { equalResourceValue } from "../../../src/resource/value.ts";
import { requireContentWriter } from "../context-write.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { OUTPUT_TYPE, type OutputSpec } from "../output/model.ts";
import { requireProcessingRoot, requireTopic } from "../topic/ownership.ts";
import { ONGOING_TYPE, OngoingSpecSchema, OngoingStatusSchema, followupInputId, type OngoingResource, type OngoingSpec, type OngoingStatus } from "./model.ts";

function validateMatter(matter: OngoingResource, context: ResourceValidationContext) {
  if (matter.metadata.namespace !== "v1" || matter.metadata.owner || matter.metadata.deletionTimestamp)
    throw new Error("Ongoing requires an independent domain resource");
  if (matter.status.closure && (matter.spec.checkAt || matter.spec.question)) throw new Error("Closed Ongoing cannot schedule checks");
  requireContentWriter(requireTopic(matter.spec.topic, context), matter.status.writer, context);
}

/** @spec Scheduling and asking each commit their receipt with the matching Input or private Output.
 * @link docs/personal/ongoing.md
 */
export const OngoingDefinition: ResourceDefinition<OngoingSpec, OngoingStatus> = {
  type: ONGOING_TYPE, schema: { spec: OngoingSpecSchema, status: OngoingStatusSchema },
  validator: {
    create(matter, context) {
      if (matter.status.followupInputId || matter.status.askedFollowupId || matter.status.closure || !matter.spec.checkAt || matter.status.planRevision !== 1)
        throw new Error("New Ongoing requires an open initial plan");
      validateMatter(matter, context);
    },
    update(before, after, context) {
      const id = followupInputId(before);
      if (before.status.followupInputId !== after.status.followupInputId) {
        const input = id && context.page<InputSpec, InputStatus>(INPUT_TYPE, { limit: 1, matchIndex: { name: "followup", value: id } }).items[0];
        if (!input || input.spec.observation?.ongoingUid !== before.metadata.uid || id !== after.status.followupInputId
          || input.status.topic?.uid !== requireProcessingRoot(before.spec.topic, context).metadata.uid
          || !equalResourceValue(before.spec, after.spec) || !equalResourceValue({ ...before.status, followupInputId: id }, after.status))
          throw new Error("Ongoing check receipt must match the scheduled Input");
        return;
      }
      if (before.status.askedFollowupId !== after.status.askedFollowupId) {
        const output = id && context.page<OutputSpec, unknown>(OUTPUT_TYPE, { limit: 1, matchIndex: { name: "followup", value: id } }).items[0];
        if (!output || !output.spec.executionId || before.status.followupInputId !== id || after.status.askedFollowupId !== id
          || !output.spec.inputIds?.includes(id) || !equalResourceValue(before.spec, after.spec)
          || !equalResourceValue({ ...before.status, askedFollowupId: id }, after.status))
          throw new Error("Ongoing question must match the accepted Output");
        requireContentWriter(requireTopic(before.spec.topic, context), { resource: ResourceRefSchema.parse(output.spec.topic), executionId: output.spec.executionId }, context);
        return;
      }
      if (before.status.closure || !equalResourceValue(before.spec.topic, after.spec.topic)) throw new Error("Ongoing is closed or its owner changed");
      const revised = before.spec.checkAt !== after.spec.checkAt || before.spec.question !== after.spec.question;
      if (after.status.planRevision !== before.status.planRevision + Number(revised)) throw new Error("Ongoing check revision mismatch");
      validateMatter(after, context);
    },
    delete(matter) { if (!matter.status.closure) throw new Error("Close Ongoing before deletion"); },
  },
  indexes: { topic: r => [r.spec.topic.uid], openTopic: r => !r.status.closure && !r.metadata.deletionTimestamp ? [r.spec.topic.uid] : [] },
  retention: { releasedAt: r => r.status.closure?.at, canEvict: r => !!r.status.closure, references: () => [] },
  printer: { summarize: r => r.spec.title, describe: r => [r.spec.title, r.status.progress, r.status.closure?.outcome].filter(Boolean).join("\n") },
};
