import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ConnectorDefinition, ConnectorPackage } from "@compforge/aide-connector";
import type { ConnectorRegistry, ConnectorLimits } from "./registry.ts";

export interface ConnectorConfiguration extends ConnectorLimits {
  readonly kind: string;
  readonly version: string;
  readonly enabled?: boolean;
  readonly config?: Readonly<Record<string, unknown>>;
}
export type ConnectorConfigurations = Readonly<Record<string, ConnectorConfiguration>>;

/**
 * @spec Only explicitly configured, already installed local/npm modules are loaded into the trusted Host.
 * @spec Configuration and environment reads stay in Host factories; callers receive only descriptions and method results.
 * @spec Invalid definitions fail before creation; invalid implementations are closed without hiding the scoped assembly error.
 * @link docs/connector/extensions.md
 * @case tests/connector-packages.test.ts
 */
export async function loadConnectorPackages(registry: ConnectorRegistry, config: ConnectorConfigurations,
  options: { baseDir?: string; environment?: Readonly<Record<string, string | undefined>>; registration?: string; definitions?: readonly ConnectorDefinition[] } = {}): Promise<void> {
  const definitions = new Map<string, { definition: ConnectorDefinition; packageIdentity: string }>();

  const baseDir = options.baseDir ?? process.cwd();
  const environment = Object.freeze({ ...(options.environment ?? process.env) });
  const require = createRequire(resolve(baseDir, "package.json"));
  if (options.registration) {
    const specifier = options.registration;
    if (/^[a-z]+:/i.test(specifier)) throw new Error("Connector packages must be installed modules or local paths");
    const path = isAbsolute(specifier) || specifier.startsWith(".") ? resolve(baseDir, specifier) : require.resolve(specifier);
    const url = pathToFileURL(path).href;
    const entry: ConnectorPackage = (await import(url)).default;
    if (!entry || typeof entry.id !== "string" || !entry.id.trim() || typeof entry.version !== "string" || !entry.version.trim() || !entry.connectors || typeof entry.connectors !== "object" || Array.isArray(entry.connectors)) throw new Error(`Invalid Connector package: ${specifier}`);
    for (const [name, definition] of Object.entries(entry.connectors)) {
      if (!name.trim() || !definition || typeof definition.config?.parse !== "function" || typeof definition.create !== "function") throw new Error(`Invalid Connector definition in ${entry.id}`);
      if (typeof definition.kind !== "string" || !definition.kind.trim()) throw new Error(`Invalid Connector kind in ${entry.id} (${name}): expected a non-empty string`);
      if (typeof definition.version !== "string" || !definition.version.trim()) throw new Error(`Invalid Connector version in ${entry.id} (${name}): expected a non-empty string`);
      definitions.set(name, { definition, packageIdentity: `${entry.id}@${entry.version}` });
    }
  }
  const created = [];
  try {
    for (const [name, binding] of Object.entries(config)) {
      if (binding.enabled === false) continue;
      const fallback = (options.definitions ?? []).find(d => d.kind === binding.kind && d.version === binding.version);
      const selected = definitions.get(name) ?? (fallback ? { definition: fallback, packageIdentity: "aide.builtin-connectors@1" } : undefined);
      if (!selected) throw new Error(`Connector implementation is not installed: ${binding.kind}/${binding.version} (${name})`);
      const { definition, packageIdentity } = selected;
      if (definition.kind !== binding.kind || definition.version !== binding.version) {
        throw new Error(`Connector contract mismatch: ${name} (${binding.kind}/${binding.version} declared, ${definition.kind}/${definition.version} registered in ${packageIdentity})`);
      }
      let parsed: unknown;
      try { parsed = definition.config.parse(binding.config ?? {}); }
      catch { throw new Error(`Invalid Connector configuration: ${name} (${binding.kind}/${binding.version})`); }
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
      } catch { abort.abort(); throw new Error(`Connector creation failed: ${name} (${binding.kind}/${binding.version})`); }
      createdFactory = true;
      try {
        if (!implementation || !implementation.handlers || typeof implementation.handlers !== "object" || Array.isArray(implementation.handlers) || (implementation.close !== undefined && typeof implementation.close !== "function")) {
          throw new Error(`Invalid Connector implementation: ${name} (${binding.kind}/${binding.version} from ${packageIdentity})`);
        }
        const revision = createHash("sha256").update(JSON.stringify([packageIdentity, name, definition.kind, definition.version, binding.config ?? {}, [...reads].sort()])).digest("hex");
        const close = implementation.close?.bind(implementation);
        created.push(registry.register(definition.kind, definition.version, name, { ...implementation, close: async () => { abort.abort(new Error("Connector closed")); await close?.(); } },
          { revision, maxConcurrentCalls: binding.maxConcurrentCalls, maxQueuedCalls: binding.maxQueuedCalls, signal: abort.signal }));
      } catch (error) {
        abort.abort();
        try { if (typeof implementation?.close === "function") await implementation.close(); }
        catch { /* Preserve the scoped assembly error even if provider cleanup fails. */ }
        throw error;
      }
    }
  } catch (error) {
    for (const ref of created.reverse()) { try { await registry.unregister(ref); } catch { /* Preserve the original assembly failure. */ } }
    throw error;
  }
}
