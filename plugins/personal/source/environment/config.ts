import { z } from "zod";
import type { EnvironmentDefinition } from "@compforge/aide-plugin";

export const ENVIRONMENT_SESSION = "source:environments";
export interface EnvironmentSourceSpec { environment: string; namespace: string; intervalMs: number }
const text = z.string().trim().min(1);
export const EnvironmentWatchSchema = z.object({
  targets: z.array(z.object({ environment: text, namespaces: z.array(text).min(1) }).strict()),
  intervalMs: z.number().int().min(30_000).max(3_600_000).default(300_000),
}).strict();

/**
 * @spec Only explicit Personal targets are observed; Connector declarations alone never start polling.
 * @spec Resolve names and aliases before deduplicating environment/namespace scopes.
 * @link docs/connector/README.md
 */
export function environmentSources(policy: z.infer<typeof EnvironmentWatchSchema> | undefined,
  environments: readonly EnvironmentDefinition[]): EnvironmentSourceSpec[] {
  if (!policy) return [];
  const seen = new Set<string>();
  return policy.targets.flatMap((target) => {
    const environment = environments.find((e) => e.name === target.environment || e.aliases?.includes(target.environment));
    if (!environment) throw new Error(`Environment Source references unknown connector: ${target.environment}`);
    if (environment.kind !== "kubernetes" || environment.host?.transport === "ssh") {
      throw new Error(`Environment Source requires local Kubernetes access: ${environment.name}`);
    }
    return target.namespaces.map((namespace) => {
      const key = JSON.stringify([environment.name, namespace]);
      if (seen.has(key)) throw new Error(`Duplicate Environment Source target: ${environment.name}/${namespace}`);
      seen.add(key);
      return { environment: environment.name, namespace, intervalMs: policy.intervalMs };
    });
  });
}
