/** Preserve both understandings for user review; never silently truncate a merge draft. */
export function mergePersonSummary(target: string, source: string): string {
  return [...new Set([target, source].filter((text) => text.trim()))].join("\n\n");
}
