import { SummaryOwnerSchema } from "../input/review.ts";
import type { ResourceContext } from "../context.ts";
import { CuratedNotesSchema } from "../input/assessment.ts";
import { NOTE_TYPE, noteMaterial, noteVersion, pendingCuration, type NoteSpec, type NoteStatus } from "../note/model.ts";
import { inputOutcome } from "./input-outcome.ts";
import { commitStatus } from "../status.ts";
import { agentCall } from "../observation/reference.ts";
import { z } from "zod";
import type { ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { TOPIC_TYPE, type TopicResource, type TopicSpec, type TopicStatus } from "../topic/model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { resourceRef, topicScope, belongsToTopic } from "../input/state.ts";
export const AssessInputSchema = z.object({ inputId: z.string().min(1), summary: z.string().min(1).max(1000),
  curatedNotes: CuratedNotesSchema.default([]) }).strict();
export type AssessInput = z.input<typeof AssessInputSchema>;
/**
 * @spec Chief records the assessment receipt independently of delegated Work.
 * @spec Chief handling business Inputs may assess pending material in its Topic subtree, including Deferred; failed assessments remain terminal.
 * @spec Assessment does not update Topic summary/recent; meaningful understanding is maintained explicitly.
 * @link docs/personal/chief.md
 */
export async function assessInput(resources: ResourceClient, owner: Readonly<TopicResource>, executionId: string, raw: unknown, toolCallId?: string) {
  const args = AssessInputSchema.parse(raw);
  for (let n = 0; ; n++) {
    const c = await resources.get<TopicSpec, TopicStatus>({ ...TOPIC_TYPE, ...owner.metadata });
    if (!c || c.metadata.uid !== owner.metadata.uid || c.metadata.deletionTimestamp || c.status.execution?.id !== executionId) throw new Error("Chief execution is no longer active");
    const input = await resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: args.inputId });
    if (!input) throw new Error("Input is unavailable");
    if (input.status.batchId) throw new Error(`This material belongs to input ${input.status.batchId}; assess the containing item`);
    const topics = await topicScope(resources, resourceRef(c));
    const topicUids = new Set(topics.map(t => t.metadata.uid));
    if (input.status.assess?.executionId !== executionId && !belongsToTopic(input, resourceRef(c), topicUids)) throw new Error("Input does not belong to this Topic subtree");
    if (input.status.assess?.lastError && !input.status.assess.retryable && !input.status.assess.completedAt) throw new Error("Input assessment has failed; submit a new Input");
    if (input.status.assess?.completedAt) return { assessed: args.inputId };
    if (input.status.assess?.executionId && input.status.assess.executionId !== executionId)
      throw new Error("Input is already admitted to another Chief execution");
    const at = new Date().toISOString();
    const accepted: typeof args.curatedNotes = [];
    const receipts: ResourceCommit[] = [];
    if (args.curatedNotes.length) {
      if (input.spec.origin !== "aide:curate" || input.status.assess?.executionId !== executionId)
        throw new Error("Only the admitted aide:curate may acknowledge Notes");
      if (new Set(args.curatedNotes.map(n => n.noteId)).size !== args.curatedNotes.length) throw new Error("Duplicate curated Note");
      for (const { noteId, version } of args.curatedNotes) {
        const note = await resources.get<NoteSpec, NoteStatus>({ ...NOTE_TYPE, namespace: "v1", name: noteId });
        // An intervening edit stays in the pending index for the next round, including on a transaction retry.
        if (!note || !pendingCuration(note) || noteVersion(note) !== version) continue;
        if (!note.spec.nature) throw new Error("Assign the retained Note a nature before acknowledging it");
        accepted.push({ noteId, version });
        receipts.push({ operation: "patchStatus", resource: note, patch: { curated: { inputUid: input.metadata.uid, material: noteMaterial(note.spec) } } });
      }
    }
    const outcome = inputOutcome(input, c, at);
    if (input.spec.origin === "aide:summary") {
      if (input.status.assess?.executionId !== executionId) throw new Error("Only the admitted Summary review may finish");
      const ref = SummaryOwnerSchema.parse(input.spec.observation?.summaryOwner);
      const subject = await resources.get<unknown, ResourceContext>(ref);
      if (subject?.metadata.uid === ref.uid && !subject.metadata.deletionTimestamp) {
        if (subject.metadata.uid === c.metadata.uid) outcome.summaryReviewedAt = at;
        else receipts.push({ operation: "patchStatus", resource: subject, patch: { summaryReviewedAt: at } });
      }
    }
    try {
      await commitStatus(resources, [
        { operation: "patchStatus", resource: input, patch: { assess: { ...input.status.assess,
          lastError: undefined, errorAt: undefined, retryable: undefined,
          ...(toolCallId ? { completedBy: agentCall(c.status, toolCallId) } : {}), completedAt: at, result: { summary: args.summary, disposition: "completed", ...(accepted.length ? { curatedNotes: accepted } : {}) },
        } } },
        ...receipts,
        { operation: "patchStatus", resource: c, patch: outcome },
      ]);
      return { assessed: args.inputId };
    } catch (e) { if (n >= 8 || !/version conflict/.test(String(e))) throw e; }
  }
}
