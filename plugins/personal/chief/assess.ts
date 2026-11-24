import { SummaryOwnerSchema } from "../input/review.ts";
import type { ResourceContext } from "../context.ts";
import { noteRoot } from "../note/reconcile.ts";
import { CuratedNotesSchema, type NoteAssessment } from "../input/assessment.ts";
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
    if (input.status.assess?.completedAt) return { assessed: args.inputId, ...(input.status.assess.result?.noteResults ? { noteResults: input.status.assess.result.noteResults } : {}) };
    if (input.status.assess?.executionId && input.status.assess.executionId !== executionId)
      throw new Error("Input is already admitted to another Chief execution");
    const at = new Date().toISOString();
    const accepted: typeof args.curatedNotes = [];
    const receipts: ResourceCommit[] = [];
    const noteResults: NoteAssessment[] = [];
    if (args.curatedNotes.length && input.spec.origin !== "aide:curate") throw new Error("Only aide:curate may acknowledge Notes");
    if (input.spec.origin === "aide:curate" && (args.curatedNotes.length || input.spec.observation?.notes !== undefined)) {
      if (input.status.assess?.executionId !== executionId) throw new Error("Only the admitted aide:curate may acknowledge Notes");
      const submitted = new Map(args.curatedNotes.map(n => [n.noteId, n.version]));
      if (submitted.size !== args.curatedNotes.length) throw new Error("Duplicate curated Note");
      const planned = CuratedNotesSchema.parse(input.spec.observation?.notes ?? []);
      for (const noteId of new Set([...submitted.keys(), ...planned.map(n => n.noteId)])) {
        const note = await resources.get<NoteSpec, NoteStatus>({ ...NOTE_TYPE, namespace: "v1", name: noteId });
        const version = submitted.get(noteId);
        if (!note || note.spec.summaryOf || note.status.retired || note.metadata.deletionTimestamp
          || (await noteRoot({ resources }, note))?.metadata.uid !== c.metadata.uid) {
          noteResults.push({ noteId, status: "unavailable" });
          continue;
        }
        if (!pendingCuration(note)) {
          noteResults.push({ noteId, status: "already_curated" });
          continue;
        }
        const material = noteMaterial(note.spec);
        if (!version || version !== noteVersion(note) || !note.spec.nature) {
          noteResults.push({ noteId, status: !version ? "deferred" : version !== noteVersion(note) ? "version_changed" : "needs_nature" });
          receipts.push({ operation: "patchStatus", resource: note, patch: { curationRetry: { inputUid: input.metadata.uid, material, at } } });
          continue;
        }
        noteResults.push({ noteId, status: "confirmed" });
        accepted.push({ noteId, version });
        receipts.push({ operation: "patchStatus", resource: note, patch: { curated: { inputUid: input.metadata.uid, material } } });
      }
      // A stale-only submission can be corrected within this Input. Explicitly omit unresolved Notes to defer them.
      if (!accepted.length && !input.status.assess.curationRetried && noteResults.some(n => n.status === "version_changed" || n.status === "needs_nature")) {
        try {
          await commitStatus(resources, [{ operation: "patchStatus", resource: input, patch: { assess: { ...input.status.assess, curationRetried: true } } }]);
          return { needsReview: args.inputId, noteResults };
        } catch (error) { if (n >= 8 || !/version conflict/.test(String(error))) throw error; }
        continue;
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
          ...(toolCallId ? { completedBy: agentCall(c.status, toolCallId) } : {}), completedAt: at, result: { summary: args.summary, disposition: "completed", ...(noteResults.length ? { noteResults } : {}), ...(accepted.length ? { curatedNotes: accepted } : {}) },
        } } },
        ...receipts,
        { operation: "patchStatus", resource: c, patch: outcome },
      ]);
      return { assessed: args.inputId, ...(noteResults.length ? { noteResults } : {}) };
    } catch (e) { if (n >= 8 || !/version conflict/.test(String(e))) throw e; }
  }
}
