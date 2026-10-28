import { z } from "zod";
export const ConditionSchema = z.object({ type: z.string().min(1), status: z.enum(["True", "False", "Unknown"]),
  reason: z.string().min(1), message: z.string(), lastTransitionTime: z.string().datetime(), observedGeneration: z.number().int().positive().optional() }).strict();
export type Condition = z.infer<typeof ConditionSchema>;
export const ConditionsSchema = z.array(ConditionSchema).default([]).refine(items => new Set(items.map(c => c.type)).size === items.length, "Condition types must be unique");
export type ConditionValue = Omit<Condition, "lastTransitionTime">;
/** @spec Each owner replaces only its condition types; reason changes preserve transition time when status is unchanged.
 * @link docs/plugin/resource.md#conditions-契约
 * @case tests/status.test.ts
 */
export function setConditions(previous: readonly Condition[] = [], values: readonly ConditionValue[], at = new Date().toISOString()): Condition[] {
  const conditions = new Map(previous.map(c => [c.type, c]));
  for (const value of values) {
    const old = conditions.get(value.type);
    conditions.set(value.type, { ...value, lastTransitionTime: old?.status === value.status ? old.lastTransitionTime : at });
  }
  return [...conditions.values()];
}
export const conditionTrue = (conditions: readonly Condition[] | undefined, type: string, generation?: number): boolean =>
  !!conditions?.some(c => c.type === type && c.status === "True" && (generation === undefined || c.observedGeneration === generation));
