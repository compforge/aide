import { PersonRefSchema } from "./person/model.ts";
import { z } from "zod";

export const SUMMARY_CHARS = 16000;
export const RECENT_COUNT = 40;
export const RECENT_CHARS = 16000;
/** @spec One resource-local Note follows one recent matter with a stable identity and Host-maintained timestamps.
 * @link docs/personal/README.md#有界认识与近期依据
 */
export const NoteSchema = z.object({ id: z.string().min(1), createdAt: z.string(), updatedAt: z.string(), text: z.string(), persons: z.array(PersonRefSchema).optional() }).strict();
export type Note = z.infer<typeof NoteSchema>;
/**
 * @spec Updated Notes move to the newest end. All persisted writes apply the same count and character budgets.
 * @link docs/personal/README.md#有界认识与近期依据
 */
export function retainRecent(entries: readonly Note[]): Note[] {
  let remaining = RECENT_CHARS;
  const retained: Note[] = [];
  const notes = [...entries].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const entry of notes.slice(-RECENT_COUNT).reverse()) {
    if (!remaining) break;
    const text = entry.text.length > remaining ? entry.text.slice(0, remaining - 1) + "…" : entry.text;
    retained.push({ ...entry, text });
    remaining -= text.length;
  }
  return retained.reverse();
}
export const ContextFields = {
  summary: z.string().max(SUMMARY_CHARS).default(""),
  recent: z.array(NoteSchema).default([]).refine(notes => new Set(notes.map(note => note.id)).size === notes.length,
    "Note IDs must be unique within a resource").transform(retainRecent),
};
/** @spec Long-lived, infrequently changing summary and recent matter Notes are maintained independently. */
export interface ResourceContext { summary: string; recent: Note[] }
