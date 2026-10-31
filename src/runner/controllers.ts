import { runnerExecution } from "./execution.ts";
import { deepFreeze } from "../reconcile/snapshot.ts";
import { validateSources } from "../reconcile/source.ts";
import { equalResourceValue } from "../resource-value.ts";
import type { Controller, PluginLogger, Resource, ResourceClient, ResourceNamespace, ReconcileSnapshot } from "@compforge/aide-plugin";
import { createReconcileContext } from "../plugin-context.ts";
import { reconcileKeyId, ReconcileCapacity, ReconcileDueQueue, ReconcileQueue, type ReconcileCapacityLease } from "../reconcile/queue.ts";
import { CronSourceQueue } from "../reconcile/cron-source.ts";
import type { ReconcileKey, ReconcileScope } from "../protocol/reconcile.ts";
import type { ExecutionScope, VerbResponse } from "../protocol/verbs.ts";
import type { HostRequest, RunnerRequest } from "../protocol/ipc.ts";

type Change = Extract<RunnerRequest, { method: "controller.change" }>["change"];
export interface ReconcileAdmission { scope: ExecutionScope; resource: Resource<unknown, unknown>; snapshot: ReconcileSnapshot }
interface Registration {
  definition: Controller<unknown, unknown>; scope: ReconcileScope; queue?: ReconcileQueue;
  abort: AbortController; attempts: Map<string, number>;
}

/** @spec One Runner owns Watch mapping, coalescing queues, retries and timers. Host owns durable state and action execution.
 * @link docs/kernel.md
 */
export class Controllers {
  private readonly registrations = new Map<string, Registration>();
  private readonly pending = new Set<Promise<unknown>>();
  private capacity?: ReconcileCapacity;
  private readonly due = new ReconcileDueQueue({ onDue: (key) => this.background(this.enqueue(this.id(key), key)) });
  private readonly cron = new CronSourceQueue({ onDue: (scope) => this.background(this.enqueueAll(this.id(scope))) });
  constructor(private readonly pluginInstanceId: string,
    private readonly resources: ResourceClient, private readonly callHost: <T>(request: HostRequest) => Promise<T>, private readonly log: PluginLogger) {}

  private id(type: { resourceApiVersion: string; resourceKind: string; controllerName?: string }) { return `controller:${type.resourceApiVersion}:${type.resourceKind}${type.controllerName ? `:${type.controllerName}` : ""}`; }
  register(id: string, definition: Controller<unknown, unknown>): void {
    if (definition.name !== undefined && !/^[a-z][a-z0-9-]{0,63}$/.test(definition.name)) throw new Error("Invalid Controller name");
    if (this.registrations.has(id)) throw new Error(`Duplicate Controller: ${id}`);
    validateSources(definition.sources, new Date());
    this.registrations.set(id, { definition, abort: new AbortController(), attempts: new Map(),
      scope: { controllerName: definition.name, pluginInstanceId: this.pluginInstanceId, namespace: "v1",
        resourceApiVersion: definition.resourceType.apiVersion, resourceKind: definition.resourceType.kind, } });
  }

  async start(id: string, maxTotalConcurrency: number, backoff: { initialDelayMs: number; maxDelayMs: number }): Promise<void> {
    const entry = this.require(id);
    if (entry.queue) return;
    this.capacity ??= new ReconcileCapacity(maxTotalConcurrency);
    entry.queue = new ReconcileQueue({ maxConcurrency: entry.definition.maxConcurrency,
      execute: (key, lease) => this.capacity!.run((global) => this.execute(entry, key, {
        suspend: (wait) => global.suspend(lease.suspend(wait)),
      })),
      onError: (key, error) => {
        if (entry.abort.signal.aborted) return;
        const attempt = (entry.attempts.get(reconcileKeyId(key)) ?? 0) + 1;
        entry.attempts.set(reconcileKeyId(key), attempt);
        const next = new Date(Date.now() + Math.min(backoff.maxDelayMs, backoff.initialDelayMs * 2 ** Math.min(attempt - 1, 30)));
        this.background(this.callHost({ method: "controller.schedule", key, nextAt: next.toISOString() }).then(() => {
          if (!entry.abort.signal.aborted) this.due.schedule(key, next);
        }));
        this.log.error("Controller reconcile failed; retry scheduled", { error, attributes: { resourceKind: key.resourceKind, resourceId: key.resourceId, attempt, nextRetryAt: next.toISOString() } });
      },
    });
    const cron = (entry.definition.sources ?? []).filter((source) => source.type === "cron");
    if (cron.length) this.cron.register(entry.scope, cron);
    for (const source of entry.definition.sources ?? []) {
      if (source.type !== "resource") continue;
      // start() may own a long-lived producer; await only its explicit setup contract.
      const reportError = (error: unknown) => this.log.error("Controller Source failed", { error, attributes: { controllerId: id, sourceId: source.sourceId } });
      try {
        await source.start({ signal: entry.abort.signal,
        emit: async (init) => {
          if (entry.abort.signal.aborted) return;
          const namespace = init.namespace ?? "v1";
          const existing = await this.resources.get({ ...entry.definition.resourceType, namespace, name: init.name });
          if (existing) {
            if (!equalResourceValue(existing.spec, init.spec)) throw new Error(`Source conflicts with ${existing.kind}/${init.name}`);
            this.background(this.enqueue(id, { ...entry.scope, namespace, resourceId: init.name }));
          } else await this.resources.create(entry.definition.resourceType, init);
        },
        reportError,
        });
      } catch (error) { reportError(error); }
    }
    await this.enqueueAll(id);
  }

  private async enqueueAll(id: string): Promise<void> {
    const entry = this.require(id);
    const resources = await this.resources.list(entry.definition.resourceType, { namespace: "v1", includeDescendants: true });
    for (const resource of resources) this.background(this.enqueue(id, { ...entry.scope, resourceId: resource.metadata.name,
      namespace: resource.metadata.namespace }));
  }
  enqueue(id: string, key: ReconcileKey): Promise<void> {
    const entry = this.require(id);
    if (!entry.queue) return Promise.reject(new Error(`Controller is not started: ${id}`));
    return entry.queue.enqueue(key);
  }
  async changed(id: string, change: Change): Promise<void> {
    const entry = this.require(id);
    if (!entry.queue || entry.abort.signal.aborted) return;
    deepFreeze(change);
    const keys = new Map<string, ReconcileKey>();
    const add = (name: string, namespace?: ResourceNamespace) => {
      if (!name?.trim()) throw new Error(`Watch ${id} returned an empty resource name`);
      const key = { ...entry.scope, resourceId: name, namespace: namespace ?? change.resource.metadata.namespace };
      keys.set(JSON.stringify([key.namespace, name]), key);
    };
    if (change.kind !== "deleted" && (change.kind !== "status-updated" || change.oldResource?.metadata.generation !== change.resource.metadata.generation) && entry.definition.resourceType.apiVersion === change.resource.apiVersion && entry.definition.resourceType.kind === change.resource.kind) add(change.resource.metadata.name);
    try {
      for (const watch of entry.definition.watches ?? []) {
        if (watch.resourceType.apiVersion !== change.resource.apiVersion || watch.resourceType.kind !== change.resource.kind) continue;
        const requests = change.kind === "created" ? await watch.handler.create({ object: change.resource })
          : change.kind === "deleted" ? await watch.handler.delete({ object: change.resource })
          : await watch.handler.update({ oldObject: change.oldResource!, newObject: change.resource });
        for (const request of requests) add(request.name, request.namespace);
      }
    } catch (error) { this.log.error("Controller Watch mapping failed", { error, attributes: { controllerId: id } }); }
    for (const key of keys.values()) this.background(this.enqueue(id, key));
  }
  private async execute(entry: Registration, key: ReconcileKey, lease: ReconcileCapacityLease): Promise<void> {
    if (entry.abort.signal.aborted) return;
    const admission = await this.callHost<ReconcileAdmission | undefined>({ method: "controller.begin", key });
    if (!admission) { this.due.schedule(key, null); return; }
    const { scope, snapshot, resource } = deepFreeze(admission);
    await runnerExecution.run(scope.executionId, async () => {
      const startedAt = performance.now();
      const attributes = { executionId: scope.executionId, controllerName: scope.controllerName ?? "default", resourceKind: resource.kind, resourceId: resource.metadata.name, resourceUid: resource.metadata.uid };
      this.log.info("Controller execution started", { attributes });
      try {
        const context = createReconcileContext(snapshot, scope, (context, request) =>
          lease.suspend(this.callHost<VerbResponse>({ method: "verb.invoke", context, request })));
        const result = await entry.definition.reconcile(context, resource);
        const after = result?.requeueAfterMs;
        if (after !== undefined && (!Number.isSafeInteger(after) || after < 1)) throw new Error("requeueAfterMs must be a positive integer");
        const finished = await this.callHost<{ deleted: boolean; nextAt?: string }>({ method: "controller.finish", scope, resource, ...(after === undefined ? {} : { requeueAfterMs: after }) });
        this.log.info("Controller execution finished", { attributes: { ...attributes, elapsedMs: Math.round(performance.now() - startedAt) } });
        entry.attempts.delete(reconcileKeyId(key));
        if (finished.deleted) entry.queue!.forgetPending(key);
        if (!entry.abort.signal.aborted) this.due.schedule(key, finished.nextAt ? new Date(finished.nextAt) : null);
      } catch (error) {
        await this.callHost({ method: "controller.finish", scope, resource, failed: String(error) }).catch(() => {});
        throw error;
      }
    });
  }

  private background(promise: Promise<unknown>): void {
    this.pending.add(promise);
    void promise.finally(() => this.pending.delete(promise)).catch(() => {});
  }
  async settled(): Promise<void> { do { await Promise.allSettled([...this.pending]); } while (this.pending.size); }
  stop(id: string): void {
    const entry = this.require(id); entry.abort.abort(); entry.queue?.close(); this.due.removeScope(entry.scope); this.cron.removeScope(entry.scope);
  }
  close(): void { for (const id of this.registrations.keys()) this.stop(id); this.due.close(); this.cron.close(); }
  private require(id: string): Registration { const entry = this.registrations.get(id); if (!entry) throw new Error(`Unknown Controller: ${id}`); return entry; }
}
