import type { EnvironmentDefinition } from "@compforge/aide-plugin";
export const ENVIRONMENT_SESSION = "source:environments";
export interface EnvironmentSourceSpec { environment: string; namespace: string; intervalMs: number }
/** Personal derives observation scopes from configured access; no user-authored destination/watch list. */
export function environmentSources(environments: readonly EnvironmentDefinition[], skip: (name: string, reason: string) => void = () => {}): EnvironmentSourceSpec[] {
  return environments.flatMap((e) => {
    if (e.kind !== "kubernetes") { skip(e.name, "Not Kubernetes"); return []; }
    if (e.host?.transport === "ssh") { skip(e.name, "SSH Kubernetes observation is unsupported"); return []; }
    if (!("namespace" in e) || !e.namespace) { skip(e.name, "No configured namespace"); return []; }
    return [{ environment: e.name, namespace: e.namespace, intervalMs: 300_000 }];
  });
}
