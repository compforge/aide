import { z } from "zod";

const text = z.string().trim().min(1);
const EnvironmentWatchSchema = z.object({
  id: text, environment: text, namespace: text.optional(),
  sessionId: text.max(200).optional(), conversationId: text.max(200).optional(),
  intervalMs: z.number().int().min(30_000).default(300_000),
}).strict();
export type EnvironmentWatch = Omit<z.infer<typeof EnvironmentWatchSchema>, "sessionId" | "conversationId"> & { sessionId: string; conversationId: string };

export function parseEnvironmentWatches(config: Readonly<Record<string, unknown>> = {}): EnvironmentWatch[] {
  const watches = z.array(EnvironmentWatchSchema).parse(config.environmentWatches ?? []).map((watch) => ({ ...watch,
    sessionId: watch.sessionId ?? watch.conversationId ?? `environment:${watch.id}`,
    conversationId: watch.conversationId ?? watch.sessionId ?? `environment:${watch.id}`,
  }));
  if (new Set(watches.map((item) => item.id)).size !== watches.length) throw new Error("Duplicate environment watch id");
  return watches;
}
