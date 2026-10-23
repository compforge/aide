import { z } from "zod";
import type { HarnessOptions } from "../configuration.ts";

export const CodexConfigSchema = z.object({
  command: z.array(z.string().trim().min(1)).min(1).optional(),
  approvalReviewer: z.enum(["user", "auto_review"]).optional(),
  model: z.string().trim().min(1).optional(),
}).strict();

export interface CodexTargetConfig {
  command: string[];
  approvalReviewer?: "user" | "auto_review";
}

export const DEFAULT_CODEX_TARGET_CONFIG: HarnessOptions = Object.freeze({
  harness: "codex",
  command: ["codex", "app-server"],
});

export function resolveCodexTargetConfig(config: HarnessOptions): CodexTargetConfig {
  const command =
    Array.isArray(config.command) &&
    config.command.length > 0 &&
    config.command.every((part) => typeof part === "string" && part.trim())
      ? [...config.command]
      : ["codex", "app-server"];
  const approvalReviewer =
    config.approvalReviewer === "user" || config.approvalReviewer === "auto_review"
      ? config.approvalReviewer
      : undefined;
  return {
    command,
    ...(approvalReviewer ? { approvalReviewer } : {}),
  };
}
