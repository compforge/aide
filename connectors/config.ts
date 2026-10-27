import { z } from "zod";

const text = z.string().trim().min(1);
/** @spec The map key is the Connector name; declarations describe contracts, not implementation installation.
 * @link docs/connector/extensions.md
 */
export const ConnectorsConfigSchema = z.record(z.string().min(1).refine(name => name === name.trim(), "Connector names must not have surrounding whitespace"), z.object({
  kind: text,
  version: text,
  enabled: z.boolean().default(true),
  config: z.record(z.string(), z.unknown()).default({}),
  maxConcurrentCalls: z.number().int().min(1).max(1024).optional(),
  maxQueuedCalls: z.number().int().min(0).max(10000).optional(),
}).strict());
export type ConnectorsConfig = z.infer<typeof ConnectorsConfigSchema>;

export function jsonObject(name: string, value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}
