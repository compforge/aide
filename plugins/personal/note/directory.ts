import type { ResourceReader } from "@compforge/aide-plugin";
import type { ResourceStorage } from "../../../src/host/resource/storage.ts";
import { browseNotePage } from "./browse.ts";
import { NOTE_TYPE, noteName, noteView, type Note, type NoteSpec, type NoteStatus } from "./model.ts";

export type NoteRelation = "subject" | "people" | "addresses";
const DIRECTORY_COUNT = 40, DIRECTORY_CHARS = 8000;
/** @spec Names discover Notes; IDs read their bodies. Directory budgets are independent of body previews.
 * @spec Stable ID ordering keeps unrelated entries in place across renames and content edits.
 * @link docs/personal/note.md
 */
export function projectNoteDirectory(notes: readonly Note[], options: { total?: number; more?: boolean; query?: Partial<Record<NoteRelation, string>> } = {}) {
  const candidates = notes.filter(n => !n.summaryOf && !n.retired).map(n => ({ id: n.id, name: noteName(n), ...(n.nameMissing || !n.name ? { nameMissing: true } : {}), nature: n.nature, updatedAt: n.updatedAt, version: n.version }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const items: typeof candidates = [];
  let chars = 0;
  for (const item of candidates) {
    const size = JSON.stringify(item).length;
    if (items.length >= DIRECTORY_COUNT || chars + size > DIRECTORY_CHARS) break;
    items.push(item); chars += size;
  }
  const total = options.total ?? (options.more ? undefined : candidates.length);
  return { items, ...(total === undefined ? {} : { total }), truncated: !!options.more || items.length < (total ?? candidates.length),
    ...(options.query ? { listNotes: options.query } : {}) };
}
/** Count indexed relations and decode only one bounded page, independently of recent body budgets. */
export function noteDirectory(storage: ResourceStorage, uid: string, relation: NoteRelation = "subject") {
  const page = browseNotePage(storage, uid, relation, { pageSize: DIRECTORY_COUNT });
  return projectNoteDirectory(page.items, { total: page.total, query: { [relation]: uid } });
}
/** Async readers disclose incomplete coverage without inventing a total; list_notes continues discovery. */
export async function readNoteDirectory(reader: ResourceReader, uid: string, relation: NoteRelation) {
  const index = { subject: "recentSubject", people: "recentPeople", addresses: "recentAddresses" }[relation];
  const page = await reader.page<NoteSpec, NoteStatus>(NOTE_TYPE, { namespace: "v1", limit: DIRECTORY_COUNT, direction: "desc", matchIndex: { name: index, value: uid } });
  return projectNoteDirectory(page.items.map(noteView), { more: !!page.metadata.continue, query: { [relation]: uid } });
}
