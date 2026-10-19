import { z } from "zod";
import type { Logger } from "pino";
import type { AideConfig } from "../../config.ts";
import { ChiefConfigSchema, resolveChiefConfig } from "./chief/config.ts";
import { PiConfigSchema, resolvePiConfig } from "./pi/config.ts";
import { loadHarnessSkills } from "./packages.ts";

export const HarnessesConfigSchema = z.object({
  pi: PiConfigSchema.prefault({}),
  chief: ChiefConfigSchema.prefault({}),
}).strict();

/**
 * @spec Resolve enabled Harness configurations before restoring Sessions or accepting input; reuse them until process exit.
 * @link docs/kernel.md
 */
export async function resolveHarnessConfigs(config: AideConfig, sources: {
  home: string; cwd: string; file: string; environment: Readonly<Record<string, string | undefined>>; log: Logger;
}) {
  const chiefSkills = await loadHarnessSkills(sources.home, "chief", config, sources.log, sources.file);
  const piSkills = await loadHarnessSkills(sources.home, "pi", config, sources.log, sources.file);
  let chief;
  let pi;
  try { chief = await resolveChiefConfig(config.harnesses.chief, { ...sources, skillPaths: chiefSkills }); }
  catch (error) { throw new Error(`${sources.file}: ${error instanceof Error ? error.message : "Chief configuration failed"}`); }
  try { pi = await resolvePiConfig({ ...sources, model: config.harnesses.pi.model, skillPaths: piSkills }); }
  catch (error) { throw new Error(`${sources.file}: harnesses.pi: ${error instanceof Error ? error.message : "configuration resolution failed"}`); }
  for (const [harness, resolved] of [["chief", chief], ["pi", pi]] as const) {
    sources.log.info({ harness, provider: resolved.model.provider, model: resolved.model.id,
      skills: resolved.skillPaths?.length ?? 0,
      modelSource: config.harnesses[harness].model ? sources.file : "Pi defaults", inheritedFrom: resolved.agentDir },
    "Resolved startup harness configuration");
  }
  return Object.freeze({ chief, pi });
}
