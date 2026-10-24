import { z } from "zod";

export const RepositorySchema = z.object({ forge: z.string().min(1), path: z.string().min(1) });
export const WatchSchema = z.object({
  id: z.string().min(1), source: z.string().min(1), topicKey: z.string().min(1).max(200).optional(),
  intervalMs: z.number().int().min(30_000).default(300_000),
  repositories: z.array(RepositorySchema).default([]),
  userKeys: z.array(z.string().trim().min(1)).min(1),
}).strict();
export type Watch = Omit<z.infer<typeof WatchSchema>, "topicKey"> & { topicKey: string };

export function requirementWatches(config: readonly z.infer<typeof WatchSchema>[]): Watch[] {
  const watches: Watch[] = config.map((watch) => ({ ...watch, topicKey: watch.topicKey ?? `source:${watch.id}` }));
  if (new Set(watches.map((item) => item.id)).size !== watches.length) throw new Error("Duplicate watch id");
  return watches;
}

/** Source references are checked before any Session starts polling. */
export function validateWatchScopes(watches: readonly Watch[], requirements: readonly { source: string }[]): void {
  for (const watch of watches) {
    if (!requirements.some((item) => item.source === watch.source)) {
      throw new Error(`Requirement Source ${watch.id} references unknown connector: ${watch.source}`);
    }
  }
}

