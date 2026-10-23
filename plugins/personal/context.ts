import { z } from "zod";

export const SUMMARY_CHARS = 16000;
export const RECENT_COUNT = 40;
export const RECENT_CHARS = 16000;
export const RecentEntrySchema = z.object({ at: z.string(), text: z.string() }).strict();
export type RecentEntry = z.infer<typeof RecentEntrySchema>;
/**
 * @spec Summary is current understanding; recent is a bounded evidence window, never an inbox or audit log.
 * @spec All persisted writes enforce the same budget, including deterministic and failure paths.
 * @link docs/personal/README.md#有界认识与近期依据
 */
export function retainRecent(entries: readonly RecentEntry[]): RecentEntry[] {
  let remaining = RECENT_CHARS;
  const retained: RecentEntry[] = [];
  for (const entry of entries.slice(-RECENT_COUNT).reverse()) {
    if (!remaining) break;
    const text = entry.text.length > remaining ? entry.text.slice(0, remaining - 1) + "…" : entry.text;
    retained.push({ at: entry.at, text });
    remaining -= text.length;
  }
  return retained.reverse();
}
export const ContextFields = {
  summary: z.string().max(SUMMARY_CHARS).default(""),
  recent: z.array(RecentEntrySchema).default([]).transform(retainRecent),
};
export interface ResourceContext { summary: string; recent: RecentEntry[] }
