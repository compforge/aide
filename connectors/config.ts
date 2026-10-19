import { z } from "zod";

const record = z.record(z.string(), z.unknown());
export const ConnectorsConfigSchema = z.object({
  environments: record.default({}), requirements: record.default({}), forges: record.default({}),
}).strict();
export type ConnectorsConfig = z.infer<typeof ConnectorsConfigSchema>;

export function jsonObject(name: string, value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}
