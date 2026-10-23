import { z } from "zod";
import type { Logger } from "pino";
import type { AideConfig } from "../../config.ts";
import { ChiefConfigSchema, resolveChiefConfig } from "./chief/config.ts";
import { PiConfigSchema, resolvePiConfig, type PiConfig } from "./pi/config.ts";
import { CodexConfigSchema, resolveCodexTargetConfig } from "./codex/config.ts";
import { ClaudeConfigSchema, resolveClaudeTargetConfig } from "./claude/config.ts";
import { DshConfigSchema, resolveDshTargetConfig } from "./dsh/config.ts";
import type { HarnessOptions } from "./configuration.ts";
import { loadHarnessSkills } from "./packages.ts";

export const HarnessesConfigSchema = z.object({
  pi: PiConfigSchema.prefault({}),
  codex: CodexConfigSchema.prefault({}),
  claude: ClaudeConfigSchema.prefault({}),
  dsh: DshConfigSchema.prefault({}),
  chief: ChiefConfigSchema.prefault({}),
  route: z.object({ model: PiConfigSchema.shape.model }).strict().prefault({}),
}).strict();

/**
 * @spec Resolve enabled Harness configurations before restoring Sessions or accepting input; reuse them until process exit.
 * @link docs/kernel.md
 */
export async function resolveHarnessConfigs(config: AideConfig, sources: {
  home: string; cwd: string; file: string; environment: Readonly<Record<string, string | undefined>>; log: Logger;
}) {
  const chiefSkills = await loadHarnessSkills(sources.home, "chief", config, sources.log, sources.file);
  let chief;
  let pi: PiConfig | undefined;
  try { chief = await resolveChiefConfig(config.harnesses.chief, { ...sources, skillPaths: chiefSkills }); }
  catch (error) { throw new Error(`${sources.file}: ${error instanceof Error ? error.message : "Chief configuration failed"}`); }
  let route: PiConfig;
  try { route = config.harnesses.route.model ? await resolvePiConfig({ ...sources, model: config.harnesses.route.model, skillPaths: [] }) : { ...chief, skillPaths: [] }; }
  catch (error) { throw new Error(`${sources.file}: harnesses.route: ${error instanceof Error ? error.message : "configuration resolution failed"}`); }
  const harness = config.defaultHarness;
  let defaultHarnessOptions: HarnessOptions;
  switch (harness) {
    case "pi": {
      const skillPaths = await loadHarnessSkills(sources.home, "pi", config, sources.log, sources.file);
      try { pi = await resolvePiConfig({ ...sources, model: config.harnesses.pi.model, skillPaths }); }
      catch (error) { throw new Error(`${sources.file}: harnesses.pi: ${error instanceof Error ? error.message : "configuration resolution failed"}`); }
      defaultHarnessOptions = { harness }; break;
    }
    case "codex": {
      const input = { harness, ...config.harnesses.codex };
      defaultHarnessOptions = { ...input, ...resolveCodexTargetConfig(input) }; break;
    }
    case "claude": {
      const input = { harness, ...config.harnesses.claude };
      defaultHarnessOptions = { ...input, ...resolveClaudeTargetConfig(input, sources.environment) }; break;
    }
    case "dsh": {
      const input = { harness, ...config.harnesses.dsh };
      defaultHarnessOptions = { harness, ...resolveDshTargetConfig(input) }; break;
    }
  }
  const defaultHarnessConfig = Object.freeze({ id: "default", harness,
    ...(typeof defaultHarnessOptions.model === "string" ? { model: defaultHarnessOptions.model } : {}) });
  sources.log.info({ harness, harnessName: defaultHarnessConfig.id }, "Resolved default execution Harness");
  for (const [harness, resolved] of [["chief", chief], ["route", route], ["pi", pi]] as const) {
    if (!resolved) continue;
    sources.log.info({ harness, provider: resolved.model.provider, model: resolved.model.id,
      skills: resolved.skillPaths?.length ?? 0,
      modelSource: config.harnesses[harness].model ? sources.file : harness === "route" ? "Chief model" : "Pi defaults", inheritedFrom: resolved.agentDir },
    "Resolved startup harness configuration");
  }
  return Object.freeze({ chief, route, pi, defaultHarnessConfig, defaultHarnessOptions: Object.freeze(structuredClone(defaultHarnessOptions)) });
}
