import { z } from "zod";
export const ORGANIZATION_COOLDOWN_MS = 15 * 60_000;
export const WeavePolicySchema = z.object({
  enabled: z.boolean().default(true),
  intervalMs: z.number().int().min(1000).default(300_000),
  maxRoots: z.number().int().min(1).max(999).default(20),
  reviewIntervalMs: z.number().int().min(1000).default(3600_000),
  batchSize: z.number().int().min(2).max(20).default(12),
}).strict();
export const weavePolicy = (config?: unknown) => WeavePolicySchema.parse(config ?? {});

/** A new independent root gets time to establish its boundary before global regrouping. */
export function separationCoolingDown(topic: import("../topic/model.ts").TopicResource) {
  const change = topic.status.organization;
  return !!change?.fromUid && !change.toUid && Date.parse(change.at) + ORGANIZATION_COOLDOWN_MS > Date.now();
}
