import { NoteWriterSchema, type NoteStatus } from "./note/model.ts";
import { z } from "zod";

export const SUMMARY_CHARS = 16000;
export const RECENT_COUNT = 40;
export const RECENT_CHARS = 16000;
export type { Note } from "./note/model.ts";
import type { Note } from "./note/model.ts";
/**
 * @spec Updated Notes move to the newest end. Read projections apply count and character budgets; stored Notes remain complete.
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
  contextWriter: NoteWriterSchema.optional(),
  summary: z.string().max(SUMMARY_CHARS).default(""),
};
/** @spec Long-lived, infrequently changing summary and recent matter Notes are maintained independently. */
export interface ResourceContext { summary: string; contextWriter?: NoteStatus["writer"] }
export interface ContextView extends ResourceContext { recent: Note[] }
