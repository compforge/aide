import type { Environment, HostEnvironment } from "@compforge/harness-common";

/** A configured deployment identity; discovery does not establish connectivity. */
export interface EnvironmentSummary extends Environment {
  readonly description?: string;
  readonly aliases?: readonly string[];
}

export type EnvironmentDefinition = EnvironmentSummary & (
  | (Environment & { readonly kind?: "generic" })
  | HostEnvironment
  | (Environment & {
      readonly kind: "kubernetes";
      readonly kubeconfig: string;
      readonly context?: string;
      readonly namespace?: string;
    })
);

export interface EnvironmentDirectory {
  list(): Promise<readonly EnvironmentSummary[]>;
  get(name: string): Promise<EnvironmentDefinition>;
}
