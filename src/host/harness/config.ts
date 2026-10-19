import { z } from "zod";
import type { Logger } from "pino";
import type { AideConfig } from "../../config.ts";
import { ChiefConfigSchema, resolveChiefConfig } from "./chief/config.ts";
import { loadChiefSkills } from "./chief/packages.ts";
import { resolveCodexTargetConfig } from "./codex/config.ts";

export const HarnessesConfigSchema = z.object({
  chief: ChiefConfigSchema.prefault({}),
}).strict();

/**
 * @spec Resolve enabled Harness configurations before restoring Sessions or accepting input; reuse them until process exit.
 * @link docs/kernel.md
 */
export async function resolveHarnessConfigs(config: AideConfig, sources: {
  home: string; cwd: string; file: string; environment: Readonly<Record<string, string | undefined>>; log: Logger;
}) {
  const skillPaths = await loadChiefSkills(sources.home, config, sources.log, sources.file);
  let chief;
  try { chief = await resolveChiefConfig(config.harnesses.chief, { ...sources, skillPaths }); }
  catch (error) { throw new Error(`${sources.file}: ${error instanceof Error ? error.message : "Harness configuration failed"}`); }
  const sandbox = z.enum(["read-only", "workspace-write", "danger-full-access"]).optional().parse(sources.environment.AIDE_SANDBOX);
  const codex = resolveCodexTargetConfig({ harness: "codex", ...(sandbox ? { command: ["codex", "app-server", "-c", `sandbox_mode="${sandbox}"`] } : {}) });
  sources.log.info({ harness: "chief", provider: chief.model.provider, model: chief.model.id, skills: skillPaths.length,
    modelSource: config.harnesses.chief.model ? sources.file : "Pi defaults", inheritedFrom: chief.agentDir }, "Resolved startup harness configuration");
  return Object.freeze({ chief, codex: Object.freeze(codex), codexModel: sources.environment.AIDE_MODEL });
}
