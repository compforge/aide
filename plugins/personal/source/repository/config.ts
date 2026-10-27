import { z } from "zod";
import { digest } from "../../chief-model.ts";

export const RepositoryWatchSchema = z.object({
  id: z.string().trim().min(1),
  forge: z.string().trim().min(1),
  refreshIntervalMs: z.number().int().min(60_000).max(7 * 86_400_000).default(6 * 3_600_000),
  retryIntervalMs: z.number().int().min(1000).max(3_600_000).default(60_000),
}).strict();
export type RepositoryWatch = z.infer<typeof RepositoryWatchSchema>;

export const RepositorySourceSpecSchema = RepositoryWatchSchema.extend({ connectionRevision: z.string() });
export type RepositorySourceSpec = z.infer<typeof RepositorySourceSpecSchema>;

export const repositorySourceName = (spec: RepositorySourceSpec) => digest([spec.id, spec.forge, spec.connectionRevision]);
