import { z } from "zod";

const units = { ms: 1, s: 1000, m: 60_000, h: 3600_000, d: 86400_000 } as const;
export function deliveryDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  return match ? Number(match[1]) * units[match[2] as keyof typeof units] : NaN;
}
const duration = z.string().refine(value => {
  const ms = deliveryDurationMs(value);
  return Number.isSafeInteger(ms) && ms > 0 && ms <= 2_147_483_647;
}, "Use a positive duration such as 1m or 1h, at most 2147483647ms");
/** @spec Absent policy means unlimited. Windows count successful Outputs, not transport fragments or attempts.
 * @link docs/personal/output.md#投递频控
 */
export const PersonDeliverySchema = z.object({
  window: z.object({ duration, maxMessages: z.number().int().min(1).max(1000) }).strict().optional(),
  minInterval: duration.optional(),
}).strict();
export type PersonDelivery = z.infer<typeof PersonDeliverySchema>;
export function deliveryHistoryMs(policy?: PersonDelivery): number {
  return Math.max(policy?.window ? deliveryDurationMs(policy.window.duration) : 0,
    policy?.minInterval ? deliveryDurationMs(policy.minInterval) : 0);
}
