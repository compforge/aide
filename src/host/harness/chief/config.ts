import { z } from "zod";
import { PiConfigSchema, resolvePiConfig } from "../pi/config.ts";
import { ChiefTriggerConfigSchema } from "../../../../agents/chief/config.ts";

export const ChiefConfigSchema = PiConfigSchema.extend({
  config: z.object({ trigger: ChiefTriggerConfigSchema.prefault({}) }).strict().prefault({}),
});
export type ChiefConfigInput = z.infer<typeof ChiefConfigSchema>;

/** @spec Chief inherits model settings explicitly and loads only its declared package skills. */
export async function resolveChiefConfig(input: Pick<ChiefConfigInput, "model" | "packages">, sources: {
  cwd: string; agentDir?: string; skillPaths: readonly string[];
  environment?: Readonly<Record<string, string | undefined>>;
}) {
  try { return await resolvePiConfig({ ...sources, model: input.model }); }
  catch (error) {
    throw new Error(`harnesses.chief: ${error instanceof Error ? error.message : "configuration resolution failed"}`);
  }
}
