import { z } from "zod";
import { connectorConfigPath, loadConnectorConfig } from "../../connectors/config.ts";
import { loadMeegoRequirementConfigs } from "../../connectors/requirements/meego.ts";

export const RepositorySchema = z.object({ forge: z.string().min(1), path: z.string().min(1) });
export const WatchSchema = z.object({
  id: z.string().min(1), source: z.string().min(1), conversationId: z.string().min(1).optional(),
  intervalMs: z.number().int().min(30_000).default(300_000),
  repositories: z.array(RepositorySchema).default([]),
});
export type Watch = Omit<z.infer<typeof WatchSchema>, "conversationId"> & { conversationId: string };

export function loadWatches(path = connectorConfigPath()): Watch[] {
  const watches: Watch[] = z.array(WatchSchema).parse(loadConnectorConfig(path)?.watches ?? []).map((watch) => ({ ...watch, conversationId: watch.conversationId ?? `source:${watch.id}` }));
  if (new Set(watches.map((item) => item.id)).size !== watches.length) throw new Error("Duplicate watch id");
  const requirements = loadMeegoRequirementConfigs(path);
  for (const watch of watches) {
    if (!requirements.find((item) => item.source === watch.source)?.userKeys?.length) {
      throw new Error(`Watch ${watch.id} requires a Meego connector with explicit assignee userKeys`);
    }
  }
  return watches;
}

