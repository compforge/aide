import type { ResourceReader, ResourceListOptions } from "@compforge/aide-plugin";
import { z } from "zod";
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

export const NoteQuerySchema = z.object({ subject: z.string().min(1).optional(), people: z.string().min(1).optional(),
  q: z.string().max(500).optional(), continue: z.string().optional(), limit: z.number().int().min(1).max(20).default(20) }).strict();
/** @spec Scan at most one indexed page per request, including empty search pages; continue preserves coverage beyond recent.
 * @link docs/personal/note.md
 */
export async function listNotes(reader: ResourceReader, raw: unknown) {
  const args = NoteQuerySchema.parse(raw);
  const page = await reader.listPage<NoteSpec, NoteStatus>(NOTE_TYPE, { namespace: "v1", limit: args.limit, continue: args.continue,
    ...(args.subject ? { matchIndex: { name: "subject", value: args.subject } } : args.people ? { matchIndex: { name: "people", value: args.people } } : {}) });
  const items = page.items.filter(n => !n.metadata.deletionTimestamp && (!args.people || n.spec.people.some(p => p.uid === args.people))
    && (!args.q || n.spec.text.toLowerCase().includes(args.q.toLowerCase()))).map(n => ({ ...noteView(n), text: n.spec.text.slice(0, 500), truncated: n.spec.text.length > 500 }));
  return { items, scanned: page.items.length, continue: page.metadata.continue, resourceVersion: page.metadata.resourceVersion };
}
