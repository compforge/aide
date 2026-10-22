import type { Resource, ResourceClient, ResourceRef, ResourceNamespace, ReconcileSnapshot } from "@compforge/aide-plugin";
import { randomUUID } from "node:crypto";
import type { ControllerRegistration } from "../../../protocol/ipc.ts";
import type { ReconcileKey, ReconcileScope } from "../../../protocol/reconcile.ts";
import type { ExecutionScope } from "../../../protocol/verbs.ts";
import type { PluginRunnerClient } from "./client.ts";
import type { PluginResourceStore } from "../resource/store.ts";
import type { ResourceClientChange } from "../resource/client.ts";
import type { Verb } from "../verb.ts";

interface Options {
  scope: ReconcileScope; registration: ControllerRegistration; runner: PluginRunnerClient;
  store: PluginResourceStore; resources: ResourceClient; verb: Verb;
  snapshot(key: ReconcileKey, resource: ResourceRef): ReconcileSnapshot;
  changed(change: ResourceClientChange): void;
  maxTotalConcurrency: number; retryBackoff: { initialDelayMs: number; maxDelayMs: number };
}

/** Host proxy owns persistence/identity only; the Runner owns all Controller scheduling. */
export class RunnerController {
  readonly scope: ReconcileScope;
  private readonly executions = new Map<string, Resource<unknown, unknown>>();
  private closed = false;
  constructor(private readonly options: Options) { this.scope = options.scope; }
  async startSources(): Promise<void> {
    await this.options.runner.request({ method: "controller.start", controllerId: this.options.registration.controllerId,
      maxTotalConcurrency: this.options.maxTotalConcurrency, retryBackoff: this.options.retryBackoff });
  }
  async enqueue(key: ReconcileKey): Promise<void> {
    await this.options.runner.request({ method: "controller.enqueue", controllerId: this.options.registration.controllerId, key });
  }
  async reconcileKeys(change: ResourceClientChange): Promise<readonly ReconcileKey[]> {
    await this.options.runner.request({ method: "controller.change", controllerId: this.options.registration.controllerId, change });
    return [];
  }
  async settled(): Promise<void> { await this.options.runner.request({ method: "controllers.settled" }); }
  scheduledReconciles() { return []; }
  ownsResource(ref: ResourceRef): boolean {
    return ref.apiVersion === this.scope.resourceApiVersion && ref.kind === this.scope.resourceKind
      && (this.options.store.find(ref, ref.name, ref.namespace as ResourceNamespace)?.metadata.uid === ref.uid);
  }
  close(): void {
    this.closed = true;
    for (const id of this.executions.keys()) this.options.verb.endRemote(id);
    this.executions.clear();
    void this.options.runner.request({ method: "controller.stop", controllerId: this.options.registration.controllerId }).catch(() => {});
  }
  async begin(key: ReconcileKey) {
    if (this.closed) throw new Error("Controller is closed");
    const ref = { apiVersion: key.resourceApiVersion, kind: key.resourceKind, namespace: key.namespace, name: key.resourceId };
    const resource = await this.options.resources.get<unknown, unknown>(ref);
    if (!resource) return;
    const resourceRef = { ...ref, uid: resource.metadata.uid };
    const scope: ExecutionScope = { controllerName: key.controllerName, aideSessionId: key.aideSessionId, pluginInstanceId: key.pluginInstanceId, namespace: key.namespace as ResourceNamespace,
      executionId: `pex_${randomUUID()}`, resourceRef };
    await this.options.verb.beginRemote(scope);
    if (this.closed) { this.options.verb.endRemote(scope.executionId); throw new Error("Controller closed during admission"); }
    this.executions.set(scope.executionId, resource);
    return { scope, resource, snapshot: this.options.snapshot(key, resourceRef) };
  }
  finish(scope: ExecutionScope, resource: Resource<unknown, unknown>, after?: number, failed?: string): { deleted: boolean; nextAt?: string } {
    const original = this.executions.get(scope.executionId);
    if (!original) throw new Error(`Controller execution is not active: ${scope.executionId}`);
    this.executions.delete(scope.executionId);
    try {
      if (original.metadata.uid !== resource.metadata.uid) throw new Error("Controller resource identity changed");
      if (failed) return { deleted: false };
      const next = after === undefined ? null : new Date(Date.now() + after);
      {
        const namespace = original.metadata.namespace as ResourceNamespace;
        const latest = this.options.store.find(original, original.metadata.name, namespace);
        if (!latest || latest.metadata.uid !== original.metadata.uid) return { deleted: true };
        if (latest.metadata.generation !== original.metadata.generation) throw new Error("Resource generation changed during reconcile");
        if (original.metadata.deletionTimestamp) {
          const deleted = this.options.store.finalizeDeletion(original, original.metadata.name, namespace);
          this.options.changed({ kind: "deleted", pluginInstanceId: this.scope.pluginInstanceId, resource: deleted });
          return { deleted: true };
        }
        this.options.store.setNextReconcileAt(original, original.metadata.name, next, { namespace, controllerName: this.scope.controllerName, expectedResourceVersion: latest.metadata.resourceVersion });
      }
      return { deleted: false, ...(next ? { nextAt: next.toISOString() } : {}) };
    } finally { this.options.verb.endRemote(scope.executionId); }
  }
  schedule(key: ReconcileKey, nextAt: string): void {
    if (this.closed) return;
    const resource = this.options.store.find({ apiVersion: key.resourceApiVersion, kind: key.resourceKind }, key.resourceId, key.namespace as ResourceNamespace);
    if (resource) this.options.store.setNextReconcileAt(resource, key.resourceId, new Date(nextAt), { namespace: resource.metadata.namespace as ResourceNamespace, controllerName: this.scope.controllerName });
  }
}
