import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function connectorConfigPath(): string {
  return process.env.AIDE_CONNECTORS ?? join(process.env.AIDE_HOME ?? join(homedir(), ".aide"), "connectors.json");
}

export function jsonObject(name: string, value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Readonly<Record<string, unknown>>;
}

export function loadConnectorConfig(path = connectorConfigPath()): Readonly<Record<string, unknown>> | undefined {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new Error(`Invalid connector JSON: ${path}`); }
  return jsonObject("Connector config", value);
}
