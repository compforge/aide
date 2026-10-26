import { z } from "zod";

export const ForgeWatchSchema = z.object({
  id: z.string().trim().min(1), forge: z.string().trim().min(1),
  author: z.string().regex(/^[a-zA-Z0-9_.-]+$/),
  intervalMs: z.number().int().min(30_000).max(3_600_000).default(300_000),
  initialLookbackMs: z.number().int().min(60_000).max(30 * 86_400_000).default(7 * 86_400_000),
}).strict();
export type ForgeWatch = z.infer<typeof ForgeWatchSchema>;
export function forgeWatches(watches: readonly ForgeWatch[], connectors: readonly { forge: string }[]): ForgeWatch[] {
  if (new Set(watches.map(w => w.id)).size !== watches.length) throw new Error("Duplicate Forge Source id");
  if (new Set(watches.map(w => JSON.stringify([w.forge, w.author]))).size !== watches.length) throw new Error("Duplicate Forge Source account");
  for (const watch of watches) if (!connectors.some(c => c.forge === watch.forge)) throw new Error(`Forge Source ${watch.id} references unknown connector: ${watch.forge}`);
  return [...watches];
}
