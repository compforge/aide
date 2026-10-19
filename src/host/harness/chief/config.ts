import { z } from "zod";
import { PiConfigSchema, resolvePiConfig } from "../pi/config.ts";

export const ChiefConfigSchema = PiConfigSchema;
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
