import { z } from "zod";
import { PiModelConfigSchema, resolvePiConfig } from "../pi/config.ts";

export const ChiefConfigSchema = z.object({
  model: PiModelConfigSchema.optional(),
  packages: z.array(z.string().trim().min(1)).default([]),
}).strict();
export type ChiefConfigInput = z.infer<typeof ChiefConfigSchema>;

/** @spec Chief inherits model settings explicitly and loads only its declared package skills. */
export async function resolveChiefConfig(input: ChiefConfigInput, sources: {
  cwd: string; agentDir?: string; skillPaths: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
}) {
  try { return await resolvePiConfig({ ...sources, model: input.model }); }
  catch (error) {
    throw new Error(`harnesses.chief: ${error instanceof Error ? error.message : "configuration resolution failed"}`);
  }
}
