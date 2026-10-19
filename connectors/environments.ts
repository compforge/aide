import type { EnvironmentDefinition, EnvironmentDirectory, EnvironmentSummary } from "@compforge/aide-plugin";

/**
 * @spec Config keys own environment identity; names and aliases share one unambiguous namespace.
 * @link docs/connector/README.md
 */
export class Environments implements EnvironmentDirectory {
  private readonly definitions = new Map<string, EnvironmentDefinition>();
  private readonly names = new Map<string, string>();

  constructor(config: readonly EnvironmentDefinition[] = []) {
    for (const entry of config) {
      const value = structuredClone(entry);
      for (const key of [value.name, ...value.aliases ?? []]) this.names.set(key, value.name);
      this.definitions.set(value.name, value);
    }
  }

  async list(): Promise<readonly EnvironmentSummary[]> {
    return [...this.definitions.values()].map(({ name, kind, description, aliases }) => ({
      name, ...(kind ? { kind } : {}), ...(description ? { description } : {}),
      ...(aliases ? { aliases: [...aliases] } : {}),
    }));
  }

  async get(name: string): Promise<EnvironmentDefinition> {
    const canonical = this.names.get(name);
    if (!canonical) throw new Error(`Unknown environment: ${name}`);
    // Consumers cannot mutate the startup snapshot; discovery never opens access paths.
    return structuredClone(this.definitions.get(canonical)!);
  }
}
