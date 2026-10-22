import type { ReconcileSnapshot, HarnessTargetSnapshot } from "@compforge/aide-plugin";
export type { ReconcileSnapshot } from "@compforge/aide-plugin";

/** @spec Reconcile receives configuration only; unrelated executions cannot grow its snapshot.
 * @link docs/kernel.md
 */
export function createReconcileSnapshot(options: {
  readonly cwd?: string;
  readonly harnessTargets?: readonly HarnessTargetSnapshot[];
}): ReconcileSnapshot {
  return Object.freeze({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    harnessTargets: Object.freeze((options.harnessTargets ?? []).map(target => Object.freeze({ ...target }))),
  });
}

export function emptyReconcileSnapshot(): ReconcileSnapshot {
  return createReconcileSnapshot({});
}
