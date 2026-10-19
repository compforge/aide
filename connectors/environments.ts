import { z } from "zod";
import type { EnvironmentDefinition, EnvironmentDirectory, EnvironmentSummary } from "@compforge/aide-plugin";

const text = z.string().trim().min(1);
const host = z.union([
  z.object({ name: text, transport: z.literal("local").optional() }).strict(),
  z.object({ name: text, transport: z.literal("ssh"), address: text }).strict(),
]);
const metadata = { description: text.optional(), aliases: z.array(text).optional(), host: host.optional() };
const definition = z.union([
  z.object({ ...metadata, kind: z.literal("host") }).strict(),
  z.object({ ...metadata, kind: z.literal("kubernetes"), kubeconfig: text, context: text.optional(), namespace: text.optional() }).strict(),
  z.object({ ...metadata, kind: z.literal("generic").optional() }).strict(),
]);

/**
 * @spec Config keys own environment identity; names and aliases share one unambiguous namespace.
 * @link docs/connector/README.md
 */
export class Environments implements EnvironmentDirectory {
  private readonly definitions = new Map<string, EnvironmentDefinition>();
  private readonly names = new Map<string, string>();

  constructor(config: Readonly<Record<string, unknown>> = {}) {
    for (const [name, raw] of Object.entries(config)) {
      if (!name.trim() || name !== name.trim()) throw new Error("Environment names must be non-empty without surrounding whitespace");
      const parsed = definition.safeParse(raw);
      // Do not render raw values: an accidental credential must not enter logs or model context.
      if (!parsed.success) throw new Error(`Invalid environment declaration: ${name}`);
      const value = { name, ...parsed.data };
      for (const key of [name, ...value.aliases ?? []]) {
        if (this.names.has(key)) throw new Error(`Duplicate environment name or alias: ${key}`);
        this.names.set(key, name);
      }
      this.definitions.set(name, value);
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
