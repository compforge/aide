import type { ReconcileScope } from "../protocol/reconcile.ts";
export function reconcileScopeId(scope: ReconcileScope): string {
  return JSON.stringify([scope.pluginInstanceId, scope.namespace, scope.resourceApiVersion, scope.resourceKind, scope.controllerName ?? ""]);
}
export function reconcileScopeLabel(scope: ReconcileScope): string {
  return `${scope.pluginInstanceId}/${scope.namespace}/${scope.resourceApiVersion}/${scope.resourceKind}`;
}
export function sameReconcileScope(left: ReconcileScope, right: ReconcileScope): boolean {
  return reconcileScopeId(left) === reconcileScopeId(right);
}
