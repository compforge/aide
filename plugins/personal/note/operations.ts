import { z } from "zod";
import type { ResourceClient } from "@compforge/aide-plugin";
import { resourceRef } from "../input/state.ts";
import { WriterResourceSchema, SubjectSchema, NOTE_TYPE, noteVersion, type NoteSpec, type NoteStatus } from "./model.ts";
import type { TopicResource } from "../topic/model.ts";

export const MoveNoteSchema = z.object({ noteId: z.string().min(1), version: z.string().min(1), subject: SubjectSchema, reason: z.string().trim().min(1).max(2000) }).strict();
/** @spec Moving preserves identity, text, people and retention age; both scopes are authorized in the transaction.
 * @link docs/personal/note.md
 * @case tests/note-knowledge.test.ts
 */
export async function moveNote(resources: ResourceClient, actor: TopicResource, raw: unknown) {
  const args = MoveNoteSchema.parse(raw);
  const note = await resources.get<NoteSpec, NoteStatus>({ ...NOTE_TYPE, namespace: "v1", name: args.noteId });
  if (!note || note.metadata.deletionTimestamp || note.status.retired || noteVersion(note) !== args.version) throw new Error("Note content version conflict; read_note again");
  if (!actor.status.execution) throw new Error("Note move requires an active Chief");
  if (JSON.stringify(note.spec.subject) === JSON.stringify(args.subject)) return { noteId: args.noteId, version: noteVersion(note) };
  const updated = await resources.replace(note, { ...note.spec, subject: args.subject }, { ...note.status,
    writer: { resource: WriterResourceSchema.parse(resourceRef(actor)), executionId: actor.status.execution.id },
    organization: { at: new Date().toISOString(), reason: args.reason, from: note.spec.subject, to: args.subject,
      writer: { resource: WriterResourceSchema.parse(resourceRef(actor)), executionId: actor.status.execution.id } } });
  return { noteId: args.noteId, version: noteVersion(updated) };
}
