import { z } from "zod";
import type { EnvironmentDefinition } from "@compforge/aide-plugin";

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

/** @spec Environment identities and aliases are validated together before the directory is constructed. */
export function resolveEnvironmentConfig(config: Readonly<Record<string, unknown>> = {}): readonly EnvironmentDefinition[] {
  const names = new Set<string>();
  return Object.entries(config).map(([name, raw]) => {
    if (!name.trim() || name !== name.trim()) throw new Error("Environment names must be non-empty without surrounding whitespace");
    const parsed = definition.safeParse(raw);
    if (!parsed.success) throw new Error(`Invalid environment declaration: ${name}`);
    const value = { name, ...parsed.data };
    for (const key of [name, ...value.aliases ?? []]) {
      if (names.has(key)) throw new Error(`Duplicate environment name or alias: ${key}`);
      names.add(key);
    }
    return value;
  });
}
