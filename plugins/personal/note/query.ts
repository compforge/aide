import type { ResourceReader, ResourceListOptions } from "@compforge/aide-plugin";
import { NOTE_TYPE, noteView, type Note, type NoteSpec, type NoteStatus } from "./model.ts";
import { retainRecent } from "../context.ts";
export interface NoteReader { list<S, T>(type: { apiVersion: string; kind: string }, options?: ResourceListOptions): readonly import("@compforge/aide-plugin").Resource<S, T>[] }
export function notes(reader: NoteReader, uid: string, index: "subject" | "people" = "subject"): Note[] {
  return retainRecent(reader.list<NoteSpec, NoteStatus>(NOTE_TYPE, { matchIndex: { name: index, value: uid } })
    .filter(n => !n.metadata.deletionTimestamp).map(noteView));
}
export async function readNotes(reader: ResourceReader, uid: string, index: "subject" | "people" = "subject"): Promise<Note[]> {
  const entries = await reader.list<NoteSpec, NoteStatus>(NOTE_TYPE, { matchIndex: { name: index, value: uid } });
  return retainRecent(entries.filter(n => !n.metadata.deletionTimestamp).map(noteView));
}
