import { z } from "zod";
import type { HarnessTargetConfig } from "../../config/types.ts";

export const ClaudeConfigSchema = z.object({
  executable: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
}).strict();

export interface ClaudeTargetConfig {
  executable?: string;
}

export const DEFAULT_CLAUDE_TARGET_CONFIG: HarnessTargetConfig = Object.freeze({
  harness: "claude",
});

export function resolveClaudeTargetConfig(config: HarnessTargetConfig, environment: Readonly<Record<string, string | undefined>> = process.env): ClaudeTargetConfig {
  const configured = typeof config.executable === "string" && config.executable.trim()
    ? config.executable
    : undefined;
  const executable = configured ?? environment.AIDE_CLAUDE_BIN;
  return executable ? { executable } : {};
}
