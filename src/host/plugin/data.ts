import { mkdirSync } from "node:fs";
import { join } from "node:path";

import type { PluginDataDirectories } from "@compforge/aide-plugin";

import type { PluginInstance } from "./instance.ts";

const RESERVED_GLOBAL_NAMES = new Set([
  "marketplaces",
  "marketplaces.json",
  "packages",
]);

function pluginDirectoryName(pluginId: string): string {
  if (!pluginId.trim()) throw new Error("pluginId must not be empty");
  const name = encodeURIComponent(pluginId);
  if (RESERVED_GLOBAL_NAMES.has(name)) {
    throw new Error(`pluginId conflicts with Aide Plugin storage: ${pluginId}`);
  }
  return name;
}

/**
 * Creates the writable directories owned by one Plugin at each persistence
 * scope. Package identity owns global paths; the concrete
 * Plugin Binding owns the narrowest path.
 */
export function preparePluginDataDirectories(
  root: string,
  instance: Pick<PluginInstance, "pluginId" | "pluginInstanceId">,
): PluginDataDirectories {
  const plugin = pluginDirectoryName(instance.pluginId);
  const directories = Object.freeze({
    global: join(root, "plugins", plugin),
    instance: join(root, "plugins", plugin, "instances", instance.pluginInstanceId),
  });
  for (const path of Object.values(directories)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return directories;
}
