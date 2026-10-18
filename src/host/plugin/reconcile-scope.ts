import type {
  ReconcileResourceOwner,
  ReconcileScope,
} from "./controller.ts";

export function reconcileResourceOwner(
  scope: ReconcileScope,
): ReconcileResourceOwner {
  const owner = scope.resourceOwner ?? "plugin";
  if (owner !== "plugin" && owner !== "aide") {
    throw new Error(`reconcile resourceOwner is invalid: ${String(owner)}`);
  }
  return owner;
}

export function reconcileScopeId(scope: ReconcileScope): string {
  return JSON.stringify([
    scope.aideSessionId,
    scope.pluginInstanceId,
    scope.namespace,
    reconcileResourceOwner(scope),
    scope.resourceApiVersion,
    scope.resourceKind,
  ]);
}

export function reconcileScopeLabel(scope: ReconcileScope): string {
  const kind =
    reconcileResourceOwner(scope) === "plugin"
      ? scope.resourceKind
      : `aide:${scope.resourceKind}`;
  return `${scope.aideSessionId}/${scope.pluginInstanceId}/${scope.namespace}/${scope.resourceApiVersion}/${kind}`;
}

export function sameReconcileScope(
  left: ReconcileScope,
  right: ReconcileScope,
): boolean {
  return (
    left.aideSessionId === right.aideSessionId &&
    left.pluginInstanceId === right.pluginInstanceId &&
    left.namespace === right.namespace &&
    left.resourceApiVersion === right.resourceApiVersion &&
    left.resourceKind === right.resourceKind &&
    reconcileResourceOwner(left) === reconcileResourceOwner(right)
  );
}
