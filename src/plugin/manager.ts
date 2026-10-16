import type { Logger } from "pino";
import type { Controller as Definition, ExecutionScope, ReconcileContext } from "./api/index.ts";
import { Controller, reconcileRetryBackoff, type ReconcileKey } from "./controller.ts";
import { CronSourceQueue } from "./cron-source.ts";
import { PluginInstanceStore } from "./instance.ts";
import { PluginBinding, type PluginPackage } from "./package.ts";
import { ReconcileCapacity, ReconcileDueQueue, type ReconcileCapacityLease } from "./queue.ts";
import { reconcileScopeId } from "./reconcile-scope.ts";
import { PluginResourceStore } from "./resource.ts";
import { createResourceClient, type ResourceClientChange } from "./resource-client.ts";
import { ResourceRegistry } from "./resource-registry.ts";

interface Registration {
  controller: Controller<unknown, unknown>;
  active: boolean;
  binding: PluginBinding;
  releaseType(): void;
}

/**
 * @spec Manager owns activation, shared capacity, change routing and timers; Controllers own reconciliation.
 * @link docs/runtime.md
 */
export class Manager {
  private readonly controllers = new Map<string, Registration>();
  private readonly bindings = new Map<string, PluginBinding>();
  private readonly activations = new Map<string, Promise<void>>();
  private readonly executions = new Map<string, ReconcileContext>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly registry = new ResourceRegistry([]);
  private readonly capacity: ReconcileCapacity;
  private readonly due: ReconcileDueQueue;
  private readonly cron: CronSourceQueue;
  private started = false;
  private closed = false;

  constructor(readonly instances: PluginInstanceStore, private readonly log: Logger, concurrency = 1) {
    this.capacity = new ReconcileCapacity(concurrency);
    this.due = new ReconcileDueQueue({ onDue: (key) => this.enqueue(key) });
    this.cron = new CronSourceQueue({ onDue: (scope) => {
      const entry = this.controllers.get(reconcileScopeId(scope));
      if (entry?.active) for (const key of entry.controller.resourceKeys()) this.enqueue(key);
    } });
  }

  resourceStore(instanceId: string): PluginResourceStore {
    this.instances.get(instanceId);
    return new PluginResourceStore({ session: this.instances.session, pluginInstanceId: instanceId });
  }

  resources(instanceId: string) {
    const instance = this.instances.get(instanceId);
    return createResourceClient(this.resourceStore(instanceId), (change) => this.changed(change),
      (type) => this.registry.registerMaterialized(instance.pluginId, type));
  }

  activate(instanceId: string, plugin: PluginPackage): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Plugin Manager is closed"));
    const existing = this.activations.get(instanceId);
    if (existing) return existing;
    if (this.bindings.has(instanceId)) return Promise.reject(new Error(`Plugin ${instanceId} is already active`));
    const activation = this.activateOnce(instanceId, plugin).finally(() => this.activations.delete(instanceId));
    this.activations.set(instanceId, activation);
    return activation;
  }

  private async activateOnce(instanceId: string, plugin: PluginPackage): Promise<void> {
    const instance = this.instances.get(instanceId);
    if (!instance.enabled) return;
    if (instance.pluginId !== plugin.pluginId || instance.packageVersion !== plugin.version) {
      throw new Error(`Package identity does not match Plugin instance ${instanceId}`);
    }
    const binding = new PluginBinding();
    this.bindings.set(instanceId, binding);
    try {
      await plugin.activate(Object.freeze({
        instance, resources: this.resources(instanceId), log: this.log.child({ pluginInstanceId: instanceId }),
        signal: binding.abort.signal,
        registerController: <S, T>(definition: Definition<S, T>) => this.register(instanceId, binding, definition),
        onClose: (cleanup: () => void | Promise<void>) => binding.onClose(cleanup),
      }));
      binding.completeActivation();
      if (this.closed) throw new Error("Plugin Manager closed during activation");
      if (this.started) await this.startBinding(binding);
      this.log.info({ pluginInstanceId: instanceId }, "Plugin activated");
    } catch (error) {
      await binding.close();
      this.bindings.delete(instanceId);
      throw error;
    }
  }

  private register<S, T>(instanceId: string, binding: PluginBinding, definition: Definition<S, T>): void {
    if (this.closed || binding.abort.signal.aborted) throw new Error("Plugin binding is closed");
    binding.assertRegistering();
    const releaseType = this.registry.registerController(this.instances.get(instanceId).pluginId, definition.resourceType);
    let controller: Controller<S, T>;
    try {
      controller = new Controller({
        ...definition, store: this.resourceStore(instanceId),
        context: (scope) => this.executions.get(scope.executionId)!,
        executeWithCapacity: (execute) => this.capacity.run(execute),
        executeReconcile: (scope, lease, execute) => this.execute(binding, scope, lease, execute),
        retry: {
          backoff: reconcileRetryBackoff(), now: () => new Date(),
          schedule: (key, next) => { if (this.isActive(key)) this.due.schedule(key, next); },
          report: (failure) => this.log.error({ ...failure, err: failure.error }, "Reconcile failed; retry scheduled"),
        },
        onSourceResource: (resource) => this.changed({ kind: "created", pluginInstanceId: instanceId, resource }, controller as Controller<unknown, unknown>),
        onResourceDeleted: (resource) => this.changed({ kind: "deleted", pluginInstanceId: instanceId, resource }),
        onWatchError: (change, err) => this.log.error({ err, kind: change.resource.kind }, "Watch mapping failed"),
      });
    } catch (error) { releaseType(); throw error; }
    const id = reconcileScopeId(controller.scope);
    if (this.controllers.has(id)) {
      releaseType(); controller.close();
      throw new Error(`Controller already registered: ${id}`);
    }
    const entry: Registration = { controller: controller as Controller<unknown, unknown>, active: false, binding, releaseType };
    this.controllers.set(id, entry);
    binding.onClose(() => {
      entry.active = false;
      this.controllers.delete(id);
      controller.close(); releaseType();
      this.due.removeScope(controller.scope); this.cron.removeScope(controller.scope);
      return controller.settled();
    });
  }

  private async execute<T>(binding: PluginBinding, scope: ExecutionScope, local: ReconcileCapacityLease, run: () => Promise<T>): Promise<T> {
    return this.capacity.run(async (global) => {
      if (binding.abort.signal.aborted) throw new Error("Plugin binding is closed");
      this.executions.set(scope.executionId, Object.freeze({ ...scope, signal: binding.abort.signal,
        suspend: <U>(wait: Promise<U>) => local.suspend(global.suspend(wait)),
      }));
      try { return await run(); } finally { this.executions.delete(scope.executionId); }
    });
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error("Plugin Manager is closed");
    if (this.started) return;
    this.started = true;
    for (const binding of this.bindings.values()) await this.startBinding(binding);
  }

  private async startBinding(binding: PluginBinding): Promise<void> {
    for (const entry of this.controllers.values()) {
      if (entry.binding !== binding || entry.active) continue;
      await entry.controller.startSources((sourceId, err) => this.log.error({ sourceId, err }, "Source failed"));
      if (this.closed || binding.abort.signal.aborted) return;
      entry.active = true;
      this.cron.register(entry.controller.scope, entry.controller.cronSources());
      const scheduled = entry.controller.scheduledReconciles();
      for (const due of scheduled) this.due.schedule(due.key, due.nextReconcileAt);
      for (const key of entry.controller.initialReconciles()) this.enqueue(key);
    }
  }

  changed(change: ResourceClientChange, source?: Controller<unknown, unknown>): void {
    if (this.closed) return;
    for (const entry of this.controllers.values()) {
      if (!entry.active || entry.controller === source) continue;
      this.track(entry.controller.reconcileKeys(change).then((keys) => {
        if (!entry.active) return;
        for (const key of keys) this.enqueue(key);
      }));
    }
  }

  private isActive(key: ReconcileKey): boolean {
    return this.controllers.get(reconcileScopeId({ ...key, namespace: "v1" }))?.active === true;
  }

  private enqueue(key: ReconcileKey): void {
    const entry = this.controllers.get(reconcileScopeId({ ...key, namespace: "v1" }));
    if (!entry?.active || this.closed) return;
    this.track(entry.controller.enqueue(key));
  }

  private track(promise: Promise<unknown>): void {
    const tracked = promise.catch((err: unknown) => {
      if (!this.closed) this.log.debug({ err }, "Controller operation rejected");
    }).finally(() => this.pending.delete(tracked));
    this.pending.add(tracked);
  }

  async settled(): Promise<void> {
    do {
      await Promise.all([...this.pending]);
      await Promise.all([...this.controllers.values()].map((entry) => entry.controller.settled()));
    } while (this.pending.size);
  }

  async deactivate(instanceId: string): Promise<void> {
    await this.activations.get(instanceId);
    const binding = this.bindings.get(instanceId);
    if (!binding) return;
    await binding.close();
    this.bindings.delete(instanceId);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.due.close(); this.cron.close();
    for (const binding of this.bindings.values()) binding.abort.abort();
    await Promise.allSettled([...this.activations.values()]);
    const results = await Promise.allSettled([...this.bindings.values()].map((binding) => binding.close()));
    await this.settled();
    for (const result of results) if (result.status === "rejected") this.log.error({ err: result.reason }, "Plugin cleanup failed");
    this.bindings.clear();
  }
}
