import { z } from "zod";
import type { HarnessOptions } from "../configuration.ts";

const text = z.string().trim().min(1);
export const DshConfigSchema = z.object({
  dshBin: text.optional(), profile: text.optional(), dshHome: text.optional(),
  provider: text.optional(), model: text.optional(), reasoningEffort: text.optional(),
  patches: z.array(text).optional(), maxTokens: z.number().int().positive().optional(),
}).strict();

export interface DshTargetConfig {
  dshBin?: string;
  profile?: string;
  patches?: string[];
  dshHome?: string;
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  maxTokens?: number;
}

export const DEFAULT_DSH_TARGET_CONFIG: HarnessOptions = Object.freeze({
  harness: "dsh",
  model: "deepseek-flash",
});

export function resolveDshTargetConfig(config: HarnessOptions): DshTargetConfig {
  if (config.command !== undefined) {
    throw new Error(
      "DSH targets no longer accept command. Remove it to use the bundled SDK runtime, or configure dshBin and patches for a custom dsh profile. See docs/harness/deepseek-harness.md.",
    );
  }
  const resolved: DshTargetConfig = { model: "deepseek-flash" };
  for (const key of ["dshBin", "profile", "dshHome", "provider", "model", "reasoningEffort"] as const) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) resolved[key] = value;
  }
  if (config.patches !== undefined) {
    if (!Array.isArray(config.patches) || !config.patches.every((path) => typeof path === "string" && path.trim())) {
      throw new Error("DSH patches must be an array of non-empty paths");
    }
    resolved.patches = config.patches;
  }
  if (config.maxTokens !== undefined) {
    if (!Number.isSafeInteger(config.maxTokens) || (config.maxTokens as number) <= 0) {
      throw new Error("DSH maxTokens must be a positive integer");
    }
    resolved.maxTokens = config.maxTokens as number;
  }
  return resolved;
}
