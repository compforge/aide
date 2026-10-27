import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConnectorDefinition, ConnectorPackage } from "@compforge/aide-connector";
import type { ConnectorRegistry, ConnectorLimits } from "./registry.ts";

export interface ConnectorConfiguration extends ConnectorLimits {
  readonly type: string;
  readonly enabled?: boolean;
  readonly config?: Readonly<Record<string, unknown>>;
}
export interface ConnectorPackageConfig {
  readonly packages?: readonly string[];
  readonly instances?: Readonly<Record<string, ConnectorConfiguration>>;
}

/**
 * @spec Only explicitly configured, already installed local/npm modules are loaded into the trusted Host.
 * @spec Configuration and environment reads stay in Host factories; callers receive only descriptions and method results.
 * @link docs/connector/extensions.md
 * @case tests/connector-packages.test.ts
 */
export async function loadConnectorPackages(registry: ConnectorRegistry, config: ConnectorPackageConfig,
  options: { baseDir?: string; environment?: Readonly<Record<string, string | undefined>>; definitions?: readonly ConnectorDefinition[] } = {}): Promise<void> {
  const definitions = new Map<string, { definition: ConnectorDefinition; packageIdentity: string }>();
  for (const definition of options.definitions ?? []) definitions.set(definition.type, { definition, packageIdentity: "aide.builtin-connectors@1" });
  const baseDir = options.baseDir ?? process.cwd();
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const require = createRequire(resolve(baseDir, "package.json"));
  const loaded = new Set<string>();
  for (const specifier of config.packages ?? []) {
    if (/^[a-z]+:/i.test(specifier)) throw new Error("Connector packages must be installed modules or local paths");
    const path = isAbsolute(specifier) || specifier.startsWith(".") ? resolve(baseDir, specifier) : require.resolve(specifier);
    const url = pathToFileURL(path).href;
    if (loaded.has(url)) throw new Error(`Connector package is configured twice: ${specifier}`);
    loaded.add(url);
    const entry: ConnectorPackage = (await import(url)).default;
    if (!entry || typeof entry.id !== "string" || !entry.id.trim() || typeof entry.version !== "string" || !entry.version.trim() || !Array.isArray(entry.connectors)) throw new Error(`Invalid Connector package: ${specifier}`);
    for (const definition of entry.connectors) {
      if (!definition?.type?.trim() || typeof definition.config?.parse !== "function" || typeof definition.create !== "function") throw new Error(`Invalid Connector definition in ${entry.id}`);
      if (definitions.has(definition.type)) throw new Error(`Connector implementation type is registered twice: ${definition.type}`);
      definitions.set(definition.type, { definition, packageIdentity: `${entry.id}@${entry.version}` });
    }
  }
  const created = [];
  try {
    for (const [name, binding] of Object.entries(config.instances ?? {})) {
      if (binding.enabled === false) continue;
      const selected = definitions.get(binding.type);
      if (!selected) throw new Error(`Connector implementation is not installed: ${binding.type} (${name})`);
      const { definition, packageIdentity } = selected;
      let parsed: unknown;
      try { parsed = definition.config.parse(binding.config ?? {}); }
      catch { throw new Error(`Invalid Connector configuration: ${name} (${binding.type})`); }
      const reads = new Map<string, string | undefined>();
      const abort = new AbortController();
      let implementation;
      let createdFactory = false;
      try {
        implementation = await definition.create({ name, signal: abort.signal,
          env(key) {
            if (createdFactory && !reads.has(key)) throw new Error("Connector environment must be resolved during creation");
            const value = environment[key]; reads.set(key, value); return value;
          } }, parsed);
      } catch { abort.abort(); throw new Error(`Connector creation failed: ${name} (${binding.type})`); }
      createdFactory = true;
      if (!implementation || typeof implementation.handlers !== "object" || (implementation.close !== undefined && typeof implementation.close !== "function")) {
        abort.abort(); throw new Error(`Invalid Connector implementation: ${name} (${binding.type})`);
      }
      const revision = createHash("sha256").update(JSON.stringify([packageIdentity, binding.type, binding.config ?? {}, [...reads].sort()])).digest("hex");
      try {
        const close = implementation.close?.bind(implementation);
        created.push(registry.register(definition.kind, name, { ...implementation, close: async () => { abort.abort(new Error("Connector closed")); await close?.(); } },
          { revision, maxConcurrentCalls: binding.maxConcurrentCalls, maxQueuedCalls: binding.maxQueuedCalls, signal: abort.signal }));
      } catch (error) { abort.abort(); await implementation.close?.(); throw error; }
    }
  } catch (error) {
    for (const ref of created.reverse()) { try { await registry.unregister(ref); } catch { /* Preserve the original assembly failure. */ } }
    throw error;
  }
}
