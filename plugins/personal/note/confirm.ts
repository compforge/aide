import { z } from "zod";
import type { ResourceClient, ResourceCommit } from "@compforge/aide-plugin";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { resourceRef } from "../input/state.ts";
import type { TopicResource } from "../topic/model.ts";
import { commitStatus } from "../status.ts";
import { noteMaterial, noteVersion, pendingCuration, NOTE_TYPE, type NoteSpec, type NoteStatus } from "./model.ts";
import { noteRoot } from "./reconcile.ts";

const CuratedNotesSchema = z.array(z.object({ noteId: z.string().min(1), version: z.string().min(1) }).strict()).max(32);
type NoteAssessment = { noteId: string; status: "confirmed" | "already_curated" | "unavailable" | "version_changed" | "needs_nature" | "deferred" };
const Confirmation = z.object({ inputId: z.string().min(1), curatedNotes: CuratedNotesSchema }).strict();
export type NoteConfirmation = z.input<typeof Confirmation>;
export async function confirmCuratedNotes(resources: ResourceClient, owner: TopicResource, executionId: string, raw: NoteConfirmation) {
  const args = Confirmation.parse(raw);
  for (let n = 0; ; n++) {
    const c = await resources.get<TopicResource["spec"], TopicResource["status"]>(resourceRef(owner));
    const input = await resources.get<InputSpec, InputStatus>({ ...INPUT_TYPE, namespace: "v1", name: args.inputId });
    if (!c || c.status.execution?.id !== executionId || input?.spec.origin !== "aide:curate" || input.status.assess?.executionId !== executionId || !input.status.assess.completedAt)
      throw new Error("Only the delivered aide:curate may confirm Notes");
    const at = new Date().toISOString();
    const receipts: ResourceCommit[] = [];
    const noteResults: NoteAssessment[] = [];
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
        if (note.status.curationRetry?.inputUid === input.metadata.uid && note.status.curationRetry.material === material) continue;
        receipts.push({ operation: "patchStatus", resource: note, patch: { curationRetry: { inputUid: input.metadata.uid, material, at } } });
        continue;
      }
      noteResults.push({ noteId, status: "confirmed" });
      receipts.push({ operation: "patchStatus", resource: note, patch: { curated: { inputUid: input.metadata.uid, material } } });
    }
    try {
      if (receipts.length) await commitStatus(resources, receipts);
      return { noteResults };
    } catch (error) { if (n >= 8 || !/version conflict/.test(String(error))) throw error; }
  }
}
