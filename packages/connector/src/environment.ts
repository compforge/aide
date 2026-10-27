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
  workloads(name: string, namespace?: string): Promise<EnvironmentSnapshot>;
}

/** Safe observation facts; manifests and access credentials never cross this boundary. */
export interface WorkloadSnapshot {
  readonly kind: "Deployment" | "StatefulSet" | "DaemonSet" | "Pod";
  readonly name: string;
  readonly uid: string;
  readonly generation: number;
  readonly desired: number;
  readonly ready: number;
  readonly images: readonly { name: string; image: string }[];
  readonly pods: readonly {
    name: string; uid: string; phase: string; ready: boolean; terminating: boolean;
    containers: readonly { name: string; image: string; imageId: string; ready: boolean; restarts: number; state: string; reason: string; lastExitReason: string }[];
  }[];
}

export interface EnvironmentSnapshot {
  readonly environment: string;
  readonly namespace: string;
  readonly observedAt: string;
  readonly workloads: readonly WorkloadSnapshot[];
}

export const EnvironmentKind = "environment";
export const EnvironmentVersion = "v1";
