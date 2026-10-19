import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";

const record = z.record(z.string(), z.unknown());
const ConfigSchema = z.object({
  connectors: z.object({
    environments: record.default({}),
    requirements: record.default({}),
    forges: record.default({}),
  }).strict().default({ environments: {}, requirements: {}, forges: {} }),
  plugins: z.record(z.string(), record).default({}),
}).strict();
export type AideConfig = z.infer<typeof ConfigSchema>;

export function configPath(home = process.env.AIDE_HOME ?? join(homedir(), ".aide")): string {
  return process.env.AIDE_CONFIG ?? join(home, "config.yaml");
}

/** @spec The host loads one configuration snapshot; plugins receive capabilities and their own config, never credentials. */
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
  if (!parsed.success) throw new Error(`Invalid Aide config structure: ${path}`);
  return parsed.data;
}
