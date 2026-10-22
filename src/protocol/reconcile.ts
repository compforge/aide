import type { AnyResourceNamespace } from "@compforge/aide-plugin";

export interface ReconcileScope {
  readonly controllerName?: string;
  readonly pluginInstanceId: string;
  readonly namespace: AnyResourceNamespace;
  readonly resourceApiVersion: string;
  readonly resourceKind: string;
}

export interface ReconcileKey extends ReconcileScope {
  readonly resourceId: string;
}

export interface ReconcileResult {
  /** 一次性动态唤醒间隔；Controller 负责换算并持久化 nextReconcileAt。 */
  requeueAfterMs?: number;
}

export interface ScheduledReconcile {
  readonly key: ReconcileKey;
  readonly nextReconcileAt: Date;
}

