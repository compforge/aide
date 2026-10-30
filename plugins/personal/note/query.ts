import type { ResourceReader, ResourceValidationContext } from "@compforge/aide-plugin";
import { z } from "zod";
import { NOTE_TYPE, noteView, type Note, type NoteSpec, type NoteStatus } from "./model.ts";
import { retainRecent, RECENT_COUNT } from "../context.ts";
export type NoteReader = Pick<ResourceValidationContext, "page" | "list">;
const recentQuery = (uid: string, index: "subject" | "people") => ({ limit: RECENT_COUNT, direction: "desc" as const,
  matchIndex: { name: index === "subject" ? "recentSubject" : "recentPeople", value: uid } });
export function notes(reader: Pick<NoteReader, "page">, uid: string, index: "subject" | "people" = "subject"): Note[] {
  return retainRecent(reader.page<NoteSpec, NoteStatus>(NOTE_TYPE, recentQuery(uid, index)).items.toReversed().map(noteView));
}
export async function readNotes(reader: ResourceReader, uid: string, index: "subject" | "people" = "subject"): Promise<Note[]> {
  const page = await reader.page<NoteSpec, NoteStatus>(NOTE_TYPE, recentQuery(uid, index));
  return retainRecent(page.items.toReversed().map(noteView));
}

/** @spec Browse full Note content in bounded newest-first pages, independently of agent context budgets. */
export async function pageNotes(reader: ResourceReader, uid: string, index: "subject" | "people", continuation?: string) {
  const page = await reader.page<NoteSpec, NoteStatus>(NOTE_TYPE, {
    ...recentQuery(uid, index), namespace: "v1", limit: 20, continue: continuation,
  });
  return { items: page.items.filter(n => !n.metadata.deletionTimestamp).map(noteView), continue: page.metadata.continue };
}

export const NoteQuerySchema = z.object({ subject: z.string().min(1).optional(), people: z.string().min(1).optional(),
  q: z.string().max(500).optional(), continue: z.string().optional(), limit: z.number().int().min(1).max(20).default(20) }).strict();
/** @spec Scan at most one indexed page per request, including empty search pages; continue preserves coverage beyond recent.
 * @link docs/personal/note.md
 */
export async function listNotes(reader: ResourceReader, raw: unknown) {
  const args = NoteQuerySchema.parse(raw);
  const page = await reader.page<NoteSpec, NoteStatus>(NOTE_TYPE, { namespace: "v1", limit: args.limit, continue: args.continue,
    ...(args.subject ? { matchIndex: { name: "subject", value: args.subject } } : args.people ? { matchIndex: { name: "people", value: args.people } } : {}) });
  const items = page.items.filter(n => !n.metadata.deletionTimestamp && (!args.people || n.spec.people.some(p => p.uid === args.people))
    && (!args.q || n.spec.text.toLowerCase().includes(args.q.toLowerCase()))).map(n => ({ ...noteView(n), text: n.spec.text.slice(0, 500), truncated: n.spec.text.length > 500 }));
  return { items, scanned: page.items.length, continue: page.metadata.continue, resourceVersion: page.metadata.resourceVersion };
}
