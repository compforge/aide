import { z } from "zod";

export const RepositorySchema = z.object({ forge: z.string().min(1), path: z.string().min(1) });
export const WatchSchema = z.object({
  id: z.string().min(1), source: z.string().min(1), conversationId: z.string().min(1).max(200).optional(), sessionId: z.string().min(1).max(200).optional(),
  intervalMs: z.number().int().min(30_000).default(300_000),
  repositories: z.array(RepositorySchema).default([]),
});
export type Watch = Omit<z.infer<typeof WatchSchema>, "conversationId" | "sessionId"> & { conversationId: string; sessionId: string };

export function parseWatches(config: Readonly<Record<string, unknown>> = {}): Watch[] {
  const watches: Watch[] = z.array(WatchSchema).parse(config.watches ?? []).map((watch) => ({ ...watch, sessionId: watch.sessionId ?? watch.conversationId ?? `source:${watch.id}`,
    conversationId: watch.conversationId ?? watch.sessionId ?? `source:${watch.id}` }));
  if (new Set(watches.map((item) => item.id)).size !== watches.length) throw new Error("Duplicate watch id");
  return watches;
}

/** Automatic polling requires an explicit personal scope, independently of connector access. */
export function validateWatchScopes(watches: readonly Watch[], requirements: readonly { source: string; userKeys?: readonly string[] }[]): void {
  for (const watch of watches) {
    if (!requirements.find((item) => item.source === watch.source)?.userKeys?.length) {
      throw new Error(`Watch ${watch.id} requires a Meego connector with explicit assignee userKeys`);
    }
  }
}

