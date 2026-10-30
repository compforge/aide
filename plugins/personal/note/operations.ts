import { z } from "zod";
import { retryOnConflict, type ResourceClient } from "@compforge/aide-plugin";
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
  if (!note || note.metadata.deletionTimestamp || noteVersion(note) !== args.version) throw new Error("Note content version conflict; read_note again");
  if (!actor.status.execution) throw new Error("Note move requires an active Chief");
  if (JSON.stringify(note.spec.subject) === JSON.stringify(args.subject)) return { noteId: args.noteId, version: noteVersion(note) };
  const updated = await resources.replace(note, { ...note.spec, subject: args.subject }, { ...note.status,
    writer: { resource: WriterResourceSchema.parse(resourceRef(actor)), executionId: actor.status.execution.id },
    organization: { at: new Date().toISOString(), reason: args.reason, from: note.spec.subject, to: args.subject } });
  return { noteId: args.noteId, version: noteVersion(updated) };
}

export const ReviewNotesSchema = z.object({ notes: z.array(z.object({ noteId: z.string().min(1), version: z.string().min(1) }).strict()).min(1).max(20) }).strict();
/** @spec A review acknowledges a set of inspected versions atomically; repeated acknowledgement preserves its first receipt.
 * @why CAS serializes first-receipt creation; retry re-reads receipts but never substitutes a new content version.
 * @case tests/note-knowledge.test.ts
 * @link docs/personal/note.md
 */
export async function reviewNotes(resources: ResourceClient, actor: TopicResource, raw: unknown) {
  const args = ReviewNotesSchema.parse(raw);
  const versions = new Map<string, string>();
  for (const ref of args.notes) {
    if (versions.has(ref.noteId) && versions.get(ref.noteId) !== ref.version)
      throw new Error(`Conflicting review versions for Note ${ref.noteId}`);
    versions.set(ref.noteId, ref.version);
  }
  if (!actor.status.execution) throw new Error("Review requires an active Chief");
  const writer = { resource: WriterResourceSchema.parse(resourceRef(actor)), executionId: actor.status.execution.id };
  await retryOnConflict(async () => {
    const writes = await Promise.all([...versions].map(async ([noteId, version]) => {
      const note = await resources.get<NoteSpec, NoteStatus>({ ...NOTE_TYPE, namespace: "v1", name: noteId });
      if (!note || note.metadata.deletionTimestamp || noteVersion(note) !== version)
        throw new Error(`Note ${noteId} changed before review; read_note again`);
      return { operation: "patchStatus" as const, resource: note,
        options: { resourceVersion: note.metadata.resourceVersion }, patch: { writer,
          reviewed: note.status.reviewed?.version === version ? note.status.reviewed : { version, at: new Date().toISOString() } } };
    }));
    await resources.commit(writes);
  });
  return { reviewed: versions.size };
}
