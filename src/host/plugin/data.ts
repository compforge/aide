import { mkdirSync } from "node:fs";
import {
  basename,
  dirname,
  join,
} from "node:path";

import type {
  PluginDataDirectories,
  PluginSessionContext,
} from "@compforge/aide-plugin";

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

function aideRoot(sessionDir: string): string {
  const sessions = dirname(sessionDir);
  if (basename(sessions) !== "sessions") {
    throw new Error(
      `Plugin data requires an AideSession under a sessions directory: ${sessionDir}`,
    );
  }
  return dirname(sessions);
}

/**
 * Creates the writable directories owned by one Plugin at each persistence
 * scope. Plugin identity owns global/Session paths; the concrete
 * Plugin Binding owns the narrowest path.
 */
export function preparePluginDataDirectories(
  session: PluginSessionContext & { readonly dir: string },
  instance: Pick<PluginInstance, "pluginId" | "pluginInstanceId">,
): PluginDataDirectories {
  const root = aideRoot(session.dir);
  const plugin = pluginDirectoryName(instance.pluginId);
  const sessionData = join(session.dir, "plugins", plugin);
  const directories = Object.freeze({
    global: join(root, "plugins", plugin),
    session: sessionData,
    instance: join(sessionData, instance.pluginInstanceId),
  });
  for (const path of Object.values(directories)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
  return directories;
}
