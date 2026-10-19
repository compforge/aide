import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

import { HarnessesConfigSchema } from "./host/harness/config.ts";
import { ConnectorsConfigSchema } from "../connectors/config.ts";

const record = z.record(z.string(), z.unknown());
/** @spec Explicit values win; defaults apply only to absent fields, never to empty lists or invalid values. */
const ConfigSchema = z.object({
  connectors: ConnectorsConfigSchema.prefault({}),
  plugins: z.record(z.string(), record).default({}),
  harnesses: HarnessesConfigSchema.prefault({}),
}).strict();
export type AideConfig = z.infer<typeof ConfigSchema>;

export function configPath(home = process.env.AIDE_HOME ?? join(homedir(), ".aide")): string {
  return process.env.AIDE_CONFIG ?? join(home, "config.yaml");
}

/**
 * @spec The host loads one validated snapshot. Explicit path > AIDE_CONFIG > AIDE_HOME/config.yaml.
 * @link docs/configuration.md
 * @case tests/harness-config.test.ts
 */
export function loadConfig(explicitPath?: string): AideConfig {
  const path = explicitPath ?? configPath();
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (explicitPath !== undefined || process.env.AIDE_CONFIG !== undefined) throw new Error(`Aide config not found: ${path}`);
      return ConfigSchema.parse({});
    }
    throw error;
  }
  const document = parseDocument(text);
  if (document.errors.length) throw new Error(`Invalid Aide YAML config: ${path}`);
  let value: unknown;
  try { value = document.toJS(); }
  catch { throw new Error(`Invalid Aide YAML config: ${path}`); }
  const parsed = ConfigSchema.safeParse(value ?? {});
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"} (${issue.code})`).join(", ");
    throw new Error(`Invalid Aide config structure: ${path}: ${fields}`);
  }
  return parsed.data;
}
