import { homedir } from "node:os";
import { join } from "node:path";
import { KubernetesClient } from "@compforge/harness-toolbox/kubernetes/client";
import { collectWorkloads, observationNamespace } from "./environments/workloads.ts";
import type { EnvironmentDefinition, EnvironmentDirectory, EnvironmentSummary } from "@compforge/aide-plugin";

/**
 * @spec Config keys own environment identity; names and aliases share one unambiguous namespace.
 * @link docs/connector/README.md
 */
export class Environments implements EnvironmentDirectory {
  private readonly definitions = new Map<string, EnvironmentDefinition>();
  private readonly names = new Map<string, string>();
  private readonly clients = new Map<string, KubernetesClient>();
  private closing?: Promise<void>;

  constructor(config: readonly EnvironmentDefinition[] = []) {
    for (const entry of config) {
      const value = structuredClone(entry);
      for (const key of [value.name, ...value.aliases ?? []]) this.names.set(key, value.name);
      this.definitions.set(value.name, value);
    }
  }

  /** @spec The connector shares Kubernetes sync across samples and releases it when closed.
   * @link docs/connector/environments.md
   */
  async workloads(name: string, namespace?: string) {
    const environment = await this.get(name);
    if (this.closing) throw new Error("Environment connector is closed");
    const selected = observationNamespace(environment, namespace);
    if (!("kubeconfig" in environment)) throw new Error("Kubernetes access is missing");
    let client = this.clients.get(environment.name);
    if (!client) {
      const kubeconfig = environment.kubeconfig.startsWith("~/")
        ? join(homedir(), environment.kubeconfig.slice(2))
        : environment.kubeconfig;
      const access = { kubeconfig, context: environment.context, namespace: selected, useCache: true };
      client = new KubernetesClient(access,
        undefined, undefined, { timeoutMs: 10_000, concurrency: 2, maxBytes: 8 * 1024 * 1024 });
      this.clients.set(environment.name, client);
    }
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(new Error("Environment observation timed out")), 25_000);
    try {
      return await collectWorkloads(client, environment.name, selected, { signal: abort.signal });
    } finally {
      clearTimeout(timeout);
      abort.abort();
    }
  }

  close(): Promise<void> {
    return this.closing ??= (async () => {
      const results = await Promise.allSettled([...this.clients.values()].map(client => client.dispose()));
      this.clients.clear();
      const failures = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
      if (failures.length) throw new AggregateError(failures, "Environment connector cleanup failed");
    })();
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
