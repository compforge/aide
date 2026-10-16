import type { ResourceNamespace } from "./namespace.ts";

export interface HostIdentity {
  readonly id: string;
  readonly dir: string;
}

export interface ExecutionScope {
  readonly hostId: string;
  readonly pluginInstanceId: string;
  readonly namespace: ResourceNamespace;
  readonly executionId: string;
}

/**
 * @spec Each reconcile gets a fresh execution identity and a cancellable lifetime.
 * @rule External waits release local and global capacity, but retain same-resource exclusion.
 * Channel questions and Harness execution are host capabilities, not runtime protocols.
 */
export interface ReconcileContext extends ExecutionScope {
  readonly signal: AbortSignal;
  suspend<T>(wait: Promise<T>): Promise<T>;
}
