import { z } from "zod";
import { LarkMessagesConfigSchema } from "./lark/config.ts";

const record = z.record(z.string(), z.unknown());
export const ConnectorsConfigSchema = z.object({
  environments: record.default({}), requirements: record.default({}), forges: record.default({}),
  lark: LarkMessagesConfigSchema.optional(),
  packages: z.array(z.string().min(1)).default([]),
  connections: z.record(z.string(), z.object({
    type: z.string().min(1), enabled: z.boolean().default(true), config: record.default({}),
    maxConcurrentCalls: z.number().int().min(1).max(1024).optional(),
    maxQueuedCalls: z.number().int().min(0).max(10000).optional(),
  }).strict()).default({}),
}).strict();
export type ConnectorsConfig = z.infer<typeof ConnectorsConfigSchema>;

export function jsonObject(name: string, value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}
