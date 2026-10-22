import { createPluginVerbs } from "../../plugin-context.ts";
import { ResourceStorage } from "../resource/storage.ts";
import { ResourcePrinters } from "./resource/printer.ts";
import { RunnerController } from "./runner/controller.ts";
import type { PluginRunnerClient } from "./runner/client.ts";
import type { ControllerRegistration as RemoteRegistration, HostRequest } from "../../protocol/ipc.ts";
import type { ConnectorClient } from "@compforge/aide-plugin";
import { emptyConnectors } from "../../connector-client.ts";
import type { PluginLogRecord } from "../../protocol/ipc.ts";

import {
  Controller,
  type ReconcileFailure,
  type ReconcileKey,
  type ReconcileRetryBackoff,
  type ReconcileScope,
  type ScheduledReconcile,
  reconcileRetryBackoff,
} from "./controller.ts";
import {
  type CreatePluginInstance,
  type PluginInstance,
  type PluginInstanceRepository,
} from "./instance.ts";
import {
  PluginBinding,
  type Controller as PluginResourceController,
  type CronSource,
  type DeferredHookStage,
  type HookStage,
  type HookSubjectMap,
  type InlineHookStage,
  type Resource,
  type ResourceRef } from "./package.ts";
import {
  PackageLoader,
  type PackageLoaderOptions,
  type PackageSource,
} from "./package-loader.ts";
import {
  reconcileKeyId,
  ReconcileCapacity,
  ReconcileDueQueue,
} from "../../reconcile/queue.ts";
import {
  CronSourceQueue,
} from "../../reconcile/cron-source.ts";
import { PluginResourceStore } from "./resource/store.ts";
import {
  createResourceClient,
  type ResourceClientChange,
} from "./resource/client.ts";

import {
  installRegistration,
  PluginSupervisor,
} from "./runner/index.ts";
import { ConnectorCalls } from "../connector/calls.ts";
import {
  emptyReconcileSnapshot,
  type ReconcileSnapshot,
} from "./reconcile-snapshot.ts";
import {
  reconcileScopeId,
  reconcileScopeLabel,
  sameReconcileScope,
} from "../../reconcile/reconcile-scope.ts";


import {
  type LogSink,
  logError,
} from "../logging.ts";
import { preparePluginDataDirectories } from "./data.ts";
import { namespaceContains } from "./namespace.ts";
import type { ResourceNamespace } from "@compforge/aide-plugin";
import { Verb, type VerbOptions } from "./verb.ts";
import { HookRegistry, HookRuntime } from "./hook.ts";
import { ResourceRegistry } from "./resource/registry.ts";
import type { HarnessTarget } from "../harness/target.ts";

export type { ReconcileFailure } from "./controller.ts";

const PLUGIN_LOG_LEVELS = new Set([
  "debug",
  "info",
  "warn",
  "error",
]);

export interface ControllerRegistration {
  close(): void;
}

export interface ControllerDefinition<TSpec, TStatus>
  extends PluginResourceController<TSpec, TStatus> {
  store: PluginResourceStore;
  now?: () => Date;
}

export interface ManagerOptions {
  /** Application-owned resources and controllers, independent of execution capabilities. */
  readonly resourceHome?: string;
  readonly resourceAdmissions?: Readonly<Record<string, import("./resource/client.ts").ResourceAdmission>>;
  readonly connectors?: ConnectorClient;
  readonly actions?: VerbOptions["actions"];
  readonly onResourceChange?: (change: ResourceClientChange) => void;
  /** 所有 Controller 合计可占用的执行容量；默认 1。 */
  maxTotalConcurrency?: number;
  /** Application-owned plugin configuration repository. */
  instances: PluginInstanceRepository;
  /** Optional execution capability. Resource-only plugins need no Harness storage. */
  harness?: VerbOptions["harness"];
  log?: LogSink;
  /** Configured HarnessTargets available in execution snapshots. */
  harnessTargets?: readonly HarnessTarget[];
  /** 当前进程可激活的可信、不可变 Package 版本。 */
  packages?: PackageLoaderOptions["packages"];
  /** Reconcile 的运行环境与 Harness 配置快照。 */
  snapshot?: () => ReconcileSnapshot;
  /** 按需加载已安装 Package；fresh 用于开发期 `development reload` 绕过模块缓存。 */
  loadPackage?: PackageLoaderOptions["loadPackage"];
  /**
   * Resolve an immutable entry without importing it into Aide. When supplied
   * with a PluginSupervisor, Marketplace Plugin code runs in a per-Binding
   * child process.
   */
  loadPackageEntry?: PackageLoaderOptions["loadPackageEntry"];
  pluginSupervisor?: PluginSupervisor;
  /** Application-supplied capability dispatch. */
  performVerb?: VerbOptions["performVerb"];
  /** Default timeout for one Hook handler. */
  hookTimeoutMs?: number;
  /** Maximum number of best-effort deferred Hook deliveries awaiting completion. */
  deferredHookQueueLimit?: number;
  /** Controller reconcile 失败后的指数退避；默认从 1 秒增长到最多 1 分钟。 */
  retryBackoff?: Partial<ReconcileRetryBackoff>;
  now?: () => Date;
  /** 单个 Instance 激活失败不阻断其他 Plugin；宿主可将失败展示到 UI 或诊断日志。 */
  onActivationError?(failure: PluginActivationFailure): void;
  /** 已激活 Runner 意外退出；Manager 会撤销该 Binding 的全部宿主注册。 */
  onRunnerFailure?(failure: PluginRunnerFailure): void;
  /** 自动重试已安排；宿主可将错误展示到 UI 或诊断日志。 */
  onReconcileError?(failure: ReconcileFailure): void;
  /** Controller resource Source initial/live observation failure. */
  onControllerSourceError?(failure: ControllerSourceFailure): void;
}

export interface PluginActivationFailure {
  readonly pluginInstanceId: string;
  readonly error: unknown;
}

export interface PluginRunnerFailure {
  readonly pluginInstanceId: string;
  readonly error: Error;
}

export interface ControllerSourceFailure {
  readonly scope: ReconcileScope;
  readonly sourceId: string;
  readonly error: unknown;
}

export interface PluginReloadResult {
  readonly activated: readonly string[];
  readonly failures: readonly PluginActivationFailure[];
}

interface ManagedController {
  scope: ReconcileScope;
  ownsResource(resource: ResourceRef): boolean;
  cronSources?(): readonly CronSource[];
  startSources?(
    onError: (sourceId: string, error: unknown) => void,
  ): Promise<void>;
  enqueue(key: ReconcileKey): Promise<void>;
  reconcileKeys(change: ResourceClientChange): Promise<readonly ReconcileKey[]>;
  close(): void;
  scheduledReconciles(): ScheduledReconcile[];
  resourceKeys?(): ReconcileKey[];
  initialReconciles?(): ReconcileKey[];
}

/**
 * Plugin 域统一入口：注册和路由 Controller，并限制所有 Plugin 的进程总并发。
 */
export class Manager {
  private readonly unsubscribeResourceGc: () => void;
  private readonly resourceChanged?: (change: ResourceClientChange) => void;
  /** Plugin definitions remain registered independently of live bindings. */
  private readonly resourceRegistry = new ResourceRegistry();
  private readonly controllers = new Map<string, ManagedController>();
  private readonly hooks: HookRuntime;
  private readonly hookRegistry = new HookRegistry();
  private readonly instances: PluginInstanceRepository;
  private readonly connectors: ConnectorClient;
  private readonly packageLoader: PackageLoader;
  private readonly pluginSupervisor?: PluginSupervisor;
  private readonly snapshot: () => ReconcileSnapshot;
  private readonly verb: Verb;
  private readonly printers = new ResourcePrinters((detail, error) => this.log?.({
    level: "error", source: "aide", component: "plugin.printer", message: "Resource printing failed",
    pluginInstanceId: detail.pluginInstanceId, attributes: { ...detail }, error: logError(error),
  }), (pluginInstanceId, type) => {
    return ResourceStorage.open(this.resourceHome).findDefinition(pluginInstanceId, type);
  });
  private readonly bindings = new Map<string, PluginBinding>();
  private readonly activations = new Map<string, Promise<void>>();
  private readonly capacity: ReconcileCapacity;
  private readonly onActivationError: ManagerOptions["onActivationError"];
  private readonly onRunnerFailure: ManagerOptions["onRunnerFailure"];
  private readonly onReconcileError: ManagerOptions["onReconcileError"];
  private readonly onControllerSourceError:
    ManagerOptions["onControllerSourceError"];
  private readonly log?: LogSink;
  private readonly retryBackoff: ReconcileRetryBackoff;
  /** Binding 激活完成前注册项可回滚，但不能提前消费 Event 或产生 Output。 */
  private readonly suspendedControllers = new Set<string>();
  private readonly now: () => Date;
  private readonly dueQueue: ReconcileDueQueue;
  private readonly cronSourceQueue: CronSourceQueue;
  private started = false;
  private starting?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;

  private readonly resourceHome: string;
  private readonly resourceAdmissions?: ManagerOptions["resourceAdmissions"];
  private readonly unsubscribeWrites?: () => void;
  constructor(options: ManagerOptions) {
    this.resourceHome = options.resourceHome ?? options.instances.home;
    this.resourceAdmissions = options.resourceAdmissions;
    this.remoteConcurrency = options.maxTotalConcurrency ?? 1;
    this.capacity = new ReconcileCapacity(this.remoteConcurrency);
    this.now = options.now ?? (() => new Date());
    this.instances = options.instances;
    this.connectors = options.connectors ?? emptyConnectors;
    this.log = options.log;
    this.pluginSupervisor = options.pluginSupervisor;
    this.packageLoader = new PackageLoader({
      ...(options.packages ? { packages: options.packages } : {}),
      ...(options.loadPackage ? { loadPackage: options.loadPackage } : {}),
      ...(options.pluginSupervisor && options.loadPackageEntry
        ? { loadPackageEntry: options.loadPackageEntry }
        : {}),
    });
    this.snapshot =
      options.snapshot ??
      (() => emptyReconcileSnapshot());
    this.verb = new Verb({
      actions: options.actions,
      connectors: this.connectors,
      harness: options.harness,
      connectorCalls: new ConnectorCalls(this.resourceHome),
      capacity: this.capacity,
      log: this.log,
      performVerb: options.performVerb,
    });
    this.hooks = new HookRuntime(this.hookRegistry, {
      snapshot: this.snapshot,
      verb: this.verb,
      invokeVerb: (context, request) => this.verb.invoke(context, request),
      log: this.log,
      ...(options.hookTimeoutMs === undefined
        ? {}
        : { defaultTimeoutMs: options.hookTimeoutMs }),
      ...(options.deferredHookQueueLimit === undefined
        ? {}
        : { deferredQueueLimit: options.deferredHookQueueLimit }),
    });
    this.onActivationError = options.onActivationError;
    this.onRunnerFailure = options.onRunnerFailure;
    this.onReconcileError = options.onReconcileError;
    this.onControllerSourceError = options.onControllerSourceError;
    this.retryBackoff = reconcileRetryBackoff(options.retryBackoff);
    this.dueQueue = new ReconcileDueQueue({
      now: this.now,
      onDue: (key) => {
        void this.enqueue(key).catch(() => {
          // The Controller error callback has already persisted and scheduled the retry.
        });
      },
    });
    this.cronSourceQueue = new CronSourceQueue({
      now: this.now,
      onDue: (scope, sources) =>
        this.enqueueCronSourceResources(scope, sources),
    });
    this.resourceChanged = options.onResourceChange;
    this.unsubscribeWrites = ResourceStorage.open(this.resourceHome).subscribeWrites((scope, resource, oldResource) => {
      const pluginInstanceId = scope;
      const kind = !oldResource ? "created"
        : resource.metadata.deletionTimestamp && !oldResource.metadata.deletionTimestamp ? "deletion-requested"
        : JSON.stringify(resource.metadata.labels) !== JSON.stringify(oldResource.metadata.labels)
          || JSON.stringify(resource.metadata.annotations) !== JSON.stringify(oldResource.metadata.annotations) ? "metadata-updated"
        : "status-updated";
      const change: ResourceClientChange = oldResource
        ? { kind: kind as "status-updated" | "metadata-updated" | "deletion-requested", pluginInstanceId, resource, oldResource }
        : { kind: "created", pluginInstanceId, resource };
      this.handlePluginResourceChange(change); this.resourceChanged?.(change);
    });
    this.unsubscribeResourceGc = ResourceStorage.open(this.resourceHome).subscribe((scope, resource) => {
      const pluginInstanceId = scope;
      const change: ResourceClientChange = { kind: "deleted", pluginInstanceId, resource };
      this.handlePluginResourceChange(change); this.resourceChanged?.(change);
    });

  }

  /** @spec All callers publish resource changes through the same Watch dispatcher. */
  private readonly remoteConcurrency: number;
  private readonly pendingReconciles = new Set<Promise<unknown>>();

  async settled(): Promise<void> {
    do {
      await Promise.allSettled([...this.pendingReconciles]);
      await Promise.all([...this.controllers.values()].filter((item): item is RunnerController => item instanceof RunnerController).map((item) => item.settled()));
    } while (this.pendingReconciles.size);
  }

  describeResource(pluginInstanceId: string, resource: Readonly<Resource<unknown, unknown>>): Promise<string> {
    return this.printers.describe(pluginInstanceId, resource);
  }

  summarizeResource(pluginInstanceId: string, resource: Readonly<Resource<unknown, unknown>>): Promise<string> {
    return this.printers.summarize(pluginInstanceId, resource);
  }

  private resourceStore(pluginInstanceId: string) {
    return new PluginResourceStore({ home: this.resourceHome, pluginInstanceId });
  }

  resourceClient(pluginInstanceId: string) {
    this.instances.get(pluginInstanceId);
    return createResourceClient(this.resourceStore(pluginInstanceId),
      change => { if (change.kind === "deleted") { this.handlePluginResourceChange(change); this.resourceChanged?.(change); } },
      type => { ResourceStorage.open(this.resourceHome).definition(pluginInstanceId, type); }, this.resourceAdmissions?.[pluginInstanceId]);
  }

  registerController<TSpec, TStatus>(
    definition: ControllerDefinition<TSpec, TStatus>,
  ): ControllerRegistration {
    return this.registerControllerInternal(definition, false);
  }

  private registerControllerInternal<TSpec, TStatus>(
    definition: ControllerDefinition<TSpec, TStatus>,
    suspended: boolean,
  ): ControllerRegistration {
    if (this.closed) throw new Error("plugin Manager is closed");
    if (definition.store.storage.home !== this.resourceHome) throw new Error("Controller resource store belongs to another application");
    const controller: Controller<TSpec, TStatus> = new Controller({
      ...definition,
      snapshot: (key, resource) => this.snapshotFor(key, resource),
      invokeVerb: (context, request) => this.verb.invoke(context, request),
      executeWithCapacity: (execute) =>
        this.capacity.run(async () => await execute()),
      executeReconcile: (scope, localLease, execute) =>
        this.verb.execute(scope, localLease, execute),
      retry: {
        backoff: this.retryBackoff,
        now: this.now,
        schedule: (key, next) => {
          if (this.controllerForKey(key) !== controller) return;
          if (this.started) this.dueQueue.schedule(key, next);
        },
        report: (failure) => {
          if (this.controllerForKey(failure.key) !== controller) return;
          this.reportFailure(failure);
        },
      },
      onResourceDeleted: (resource) => {
        this.handlePluginResourceChange(Object.freeze({
          kind: "deleted",
          pluginInstanceId: definition.store.pluginInstanceId,
          resource,
        }));
      },
      onWatchError: (change, error) =>
        this.reportWatchFailure(controller.scope, change, error),
    });
    return this.installController(controller, suspended);
  }



  enqueue(key: ReconcileKey): Promise<void> {
    if (this.closed) return Promise.reject(new Error("plugin Manager is closed"));
    const controller = this.controllerForKey(key);
    if (!controller) {
      return Promise.reject(
        new Error(`no plugin Controller registered for ${reconcileScopeLabel(key)}`),
      );
    }
    if (this.suspendedControllers.has(reconcileScopeId(controller.scope))) {
      return Promise.reject(new Error("plugin Controller is not active"));
    }
    const pending = controller.enqueue(key);
    this.pendingReconciles.add(pending);
    void pending.finally(() => this.pendingReconciles.delete(pending)).catch(() => {});
    return pending;
  }

  private controllerForKey(key: ReconcileScope): ManagedController | undefined {
    const exact = this.controllers.get(reconcileScopeId(key));
    if (exact) return exact;
    return [...this.controllers.values()].find((controller) => {
      const scope = controller.scope;
      return scope.pluginInstanceId === key.pluginInstanceId &&
        scope.resourceApiVersion === key.resourceApiVersion &&
        scope.resourceKind === key.resourceKind &&
        (scope.controllerName ?? "") === (key.controllerName ?? "") &&
        namespaceContains(
          scope.namespace as ResourceNamespace,
          key.namespace as ResourceNamespace,
        );
    });
  }

  /** 收口崩溃遗留的 Plugin execution，再恢复 Resource due time。 */
  start(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("plugin Manager is closed"));
    if (this.started) return Promise.resolve();
    if (this.starting) return this.starting;
    const starting = this.startManager();
    this.starting = starting;
    void starting.then(
      () => {
        if (this.starting === starting) this.starting = undefined;
      },
      () => {
        if (this.starting === starting) this.starting = undefined;
      },
    );
    return starting;
  }

  /**
   * 将一份已启用 Instance 原子绑定到对应 Package。失败时撤销本次已产生的全部注册。
   */
  async activateInstance(pluginInstanceId: string): Promise<void> {
    if (this.closed) throw new Error("plugin Manager is closed");
    if (this.bindings.has(pluginInstanceId)) return;
    const existing = this.activations.get(pluginInstanceId);
    if (existing) return await existing;

    const instance = this.instances.get(pluginInstanceId);
    if (!instance.enabled) {
      throw new Error(`plugin Instance is disabled: ${pluginInstanceId}`);
    }
    const packageSource = await this.packageLoader.load(instance);
    await this.prepareResourceDefinitions(instance, packageSource);
    const runtime = { cwd: this.snapshot().cwd };

    const resources = this.resourceClient(instance.pluginInstanceId);
    const dataDirs = preparePluginDataDirectories(this.resourceHome, instance);
    const binding = new PluginBinding(
      instance,
      runtime,
      dataDirs,
      {
        describeResource: (resource) => this.describeResource(instance.pluginInstanceId, resource),
        summarizeResource: (resource) => this.summarizeResource(instance.pluginInstanceId, resource),
        registerHook: (hook) =>
          this.hookRegistry.register(
            {

              pluginInstanceId: instance.pluginInstanceId,
              pluginId: instance.pluginId,
              namespace: "v1",
            },
            hook,
          ),
        registerController: (controller) =>
          this.bindController(instance, controller),
        writeLog: (entry) => this.writePluginLog(instance, entry),
      },
      resources,
      this.connectors,
    );
    let activation!: Promise<void>;
    activation = Promise.resolve()
      .then(async () => {
        try {
          if (packageSource.kind === "in-process") {
            await packageSource.plugin.activate(binding);
          } else {
            if (!this.pluginSupervisor) {
              throw new Error("Plugin Supervisor is unavailable");
            }
            const runner = await this.pluginSupervisor.activate(
              packageSource.entry,
              instance,
              runtime,
              dataDirs,
              {
                resources,
                printers: binding.printers,
                controllerRequest: (request) => this.handleControllerRequest(instance, request),
                connectors: binding.connectors,
                invokeVerb: (context, request) => {
                  if (context.pluginInstanceId !== instance.pluginInstanceId) {
                    throw new Error(
                      `Plugin Runner execution scope must belong to ${instance.pluginInstanceId}`,
                    );
                  }
                  return this.verb.invoke(context, request);
                },
                onLog: (entry) => this.writePluginLog(instance, entry),
                onOutput: (stream, output) =>
                  this.writePluginLog(instance, {
                    level: stream === "stderr" ? "warn" : "debug",
                    message: `Plugin Runner wrote to ${stream}`,
                    context: {
                      component: `runner.${stream}`,
                      attributes: { output },
                    },
                  }),
                onFailure: (error) =>
                  this.handleRunnerFailure(
                    instance.pluginInstanceId,
                    error,
                  ),
              },
            );
            // Register Runner cleanup first so reverse-order Binding close
            // withdraws host registrations before terminating third-party code.
            binding.lifecycle.onClose(() => runner.close());
            for (const registration of runner.activation.registrations) {
              if (registration.kind === "controller") {
                binding.lifecycle.onClose(this.bindRunnerController(instance, runner.client, registration, resources));
              } else installRegistration(binding, runner.client, registration);
            }
          }
          binding.completeActivation();
          if (this.closed) throw new Error("plugin Manager is closed");
          this.bindings.set(pluginInstanceId, binding);
          this.log?.({
            level: "info",
            source: "aide",
            component: "plugin.activation",
            message: "Plugin activated",
            pluginId: instance.pluginId,
            pluginInstanceId: instance.pluginInstanceId,
            packageVersion: instance.packageVersion,
          });
          await this.resumeControllers(pluginInstanceId);
        } catch (error) {
          try {
            await binding.close();
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              `could not activate plugin Instance ${pluginInstanceId}`,
            );
          }
          throw error;
        }
      })
      .finally(() => {
        if (this.activations.get(pluginInstanceId) === activation) {
          this.activations.delete(pluginInstanceId);
        }
      });
    this.activations.set(pluginInstanceId, activation);
    await activation;
  }

  async deactivateInstance(pluginInstanceId: string): Promise<void> {
    const activation = this.activations.get(pluginInstanceId);
    if (activation) await activation;
    const binding = this.bindings.get(pluginInstanceId);
    if (!binding) return;
    this.bindings.delete(pluginInstanceId);
    this.verb.failInstance(
      pluginInstanceId,
      "Plugin instance was deactivated",
    );
    await binding.close();
  }

  isInstanceActive(pluginInstanceId: string): boolean {
    return this.bindings.has(pluginInstanceId);
  }

  listInstances(): PluginInstance[] {
    return this.instances.list();
  }

  inlineHook<S extends InlineHookStage>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): Promise<void> {
    return this.hooks.inline(stage, subject);
  }

  deferHook<S extends DeferredHookStage>(
    stage: S,
    subject: Readonly<HookSubjectMap[S]>,
  ): void {
    this.hooks.defer(stage, subject);
  }

  hasHook(stage: HookStage): boolean {
    return this.hookRegistry.has(stage);
  }

  /**
   * Instance 先以 disabled 落盘，再显式启用；激活失败时仍保留一份可诊断、可重试的配置。
   */
  async createInstance(input: CreatePluginInstance): Promise<PluginInstance> {
    if (this.closed) throw new Error("plugin Manager is closed");
    await this.start();
    const shouldEnable = input.enabled ?? true;
    const instance = this.instances.create({ ...input, enabled: false });
    if (!shouldEnable) return instance;
    return await this.setInstanceEnabled(instance.pluginInstanceId, true);
  }

  async setInstanceEnabled(
    pluginInstanceId: string,
    enabled: boolean,
  ): Promise<PluginInstance> {
    if (this.closed) throw new Error("plugin Manager is closed");
    await this.start();
    const current = this.instances.get(pluginInstanceId);
    if (!enabled) {
      const disabled = this.instances.setEnabled(pluginInstanceId, false);
      await this.deactivateInstance(pluginInstanceId);
      return disabled;
    }
    if (current.enabled && this.isInstanceActive(pluginInstanceId)) return current;
    const next = current.enabled
      ? current
      : this.instances.setEnabled(pluginInstanceId, true);
    try {
      await this.activateInstance(pluginInstanceId);
      return next;
    } catch (error) {
      if (!current.enabled) this.instances.setEnabled(pluginInstanceId, false);
      throw error;
    }
  }

  /**
   * 显式升级一份 Instance 的 Package 引用，并保留其稳定身份、配置和启用状态。
   * 新版本激活失败时恢复旧引用与旧 Binding，避免一次更新留下半迁移状态。
   */
  async setInstancePackageVersion(
    pluginInstanceId: string,
    packageVersion: string,
  ): Promise<PluginInstance> {
    if (this.closed) throw new Error("plugin Manager is closed");
    await this.start();
    const current = this.instances.get(pluginInstanceId);
    if (current.packageVersion === packageVersion) return current;

    await this.packageLoader.load(
      Object.freeze({ ...current, packageVersion }),
    );
    const wasActive = this.isInstanceActive(pluginInstanceId);
    if (wasActive) await this.deactivateInstance(pluginInstanceId);
    const updated = this.instances.setPackageVersion(pluginInstanceId, packageVersion);
    if (!current.enabled) return updated;

    try {
      await this.activateInstance(pluginInstanceId);
      return updated;
    } catch (error) {
      this.instances.setPackageVersion(pluginInstanceId, current.packageVersion);
      if (!wasActive) throw error;
      try {
        await this.activateInstance(pluginInstanceId);
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `could not update plugin Instance ${pluginInstanceId} or restore ${current.packageVersion}`,
        );
      }
      throw error;
    }
  }

  async removeInstance(pluginInstanceId: string): Promise<void> {
    if (this.closed) throw new Error("plugin Manager is closed");
    await this.start();
    await this.deactivateInstance(pluginInstanceId);
    this.instances.delete(pluginInstanceId);
  }

  /**
   * 重载应用的全部 enabled Instance。Package 每个版本只 fresh load 一次；
   * 单个 Package 或 Instance 失败不阻断其它插件，也不改变用户的 enabled 配置。
   */
  async reload(): Promise<PluginReloadResult> {
    if (this.closed) throw new Error("plugin Manager is closed");
    await this.start();
    const failures = new Map<string, PluginActivationFailure>();
    for (const pluginInstanceId of [...this.bindings.keys()].reverse()) {
      try {
        await this.deactivateInstance(pluginInstanceId);
      } catch (error) {
        failures.set(pluginInstanceId, { pluginInstanceId, error });
      }
    }

    const enabled = this.instances.list().filter((instance) => instance.enabled);
    const packageFailures = new Map<string, unknown>();
    const loadedPackages = new Set<string>();
    for (const instance of enabled) {
      const key = this.packageLoader.sourceKey(instance);
      if (loadedPackages.has(key)) continue;
      loadedPackages.add(key);
      try {
        await this.packageLoader.load(instance, true);
      } catch (error) {
        packageFailures.set(key, error);
      }
    }

    const activated: string[] = [];
    for (const instance of enabled) {
      if (failures.has(instance.pluginInstanceId)) continue;
      const error = packageFailures.get(
        this.packageLoader.sourceKey(instance),
      );
      if (error) {
        failures.set(instance.pluginInstanceId, {
          pluginInstanceId: instance.pluginInstanceId,
          error,
        });
        continue;
      }
      try {
        await this.activateInstance(instance.pluginInstanceId);
        activated.push(instance.pluginInstanceId);
      } catch (activationError) {
        failures.set(instance.pluginInstanceId, {
          pluginInstanceId: instance.pluginInstanceId,
          error: activationError,
        });
      }
    }
    const failureList = [...failures.values()];
    for (const failure of failureList) this.reportActivationFailure(failure);
    return Object.freeze({
      activated: Object.freeze(activated),
      failures: Object.freeze(failureList.map((failure) => Object.freeze(failure))),
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const closing = this.closeManager();
    this.closing = closing;
    return closing;
  }

  /** Bind host-side Harness tools to an already admitted Plugin execution. */
  executionVerbs(executionId: string, attributes: Readonly<Record<string, unknown>>) {
    const scope = { ...this.verb.executionScope(executionId), attributes };
    return createPluginVerbs(scope, (scope, request) => this.verb.invoke(scope, request));
  }

  interruptExecution(executionId: string): void { this.verb.interruptExecution(executionId); }

  listHarnessInvocations() {
    return this.verb.listHarnessInvocations();
  }

  async cancelHarnessInvocation(identifier?: string): Promise<boolean> {
    return this.verb.cancelHarnessInvocation(identifier);
  }


  private snapshotFor(key: ReconcileKey, resource: ResourceRef): ReconcileSnapshot {
    return this.snapshot();
  }

  /** @spec Load declarations before restoration and Controller activation; Runner loss cannot remove resource constraints. */
  private async prepareResourceDefinitions(instance: PluginInstance, source: PackageSource): Promise<void> {
    const definitions: readonly import("@compforge/aide-plugin").ResourceDefinition[] = source.kind === "in-process"
      ? source.plugin.resources ?? []
      : source.entry.resourcesUrl ? (await import(source.entry.resourcesUrl)).default : [];
    if (!Array.isArray(definitions)) throw new Error(`Invalid resource definitions for ${instance.pluginId}: expected an array`);
    this.resourceRegistry.check(instance.pluginId, definitions.map((d) => d.type));
    ResourceStorage.open(this.resourceHome).register(instance.pluginInstanceId, definitions);
    this.resourceRegistry.declare(instance.pluginId, definitions.map((d) => d.type));
  }

  private async startManager(): Promise<void> {
    const enabled = this.instances.list().filter((instance) => instance.enabled);
    const declarationErrors = new Map<string, unknown>();
    for (const instance of enabled) {
      try { await this.prepareResourceDefinitions(instance, await this.packageLoader.load(instance)); }
      catch (error) { declarationErrors.set(instance.pluginInstanceId, error); }
    }
    const failures = await Promise.all(
      enabled.map(async (instance): Promise<PluginActivationFailure | undefined> => {
        try {
          if (declarationErrors.has(instance.pluginInstanceId)) throw declarationErrors.get(instance.pluginInstanceId);
          await this.activateInstance(instance.pluginInstanceId);
          return undefined;
        } catch (error) {
          return { pluginInstanceId: instance.pluginInstanceId, error };
        }
      }),
    );
    for (const failure of failures) {
      if (failure) this.reportActivationFailure(failure);
    }
    this.verb.failOrphans();
    const controllers = [...this.controllers.values()];
    const scheduled = controllers.map((controller) => ({
      controller,
      entries: controller.scheduledReconciles(),
    }));
    for (const { controller, entries } of scheduled) {
      if (this.controllers.get(reconcileScopeId(controller.scope)) !== controller) continue;
      for (const entry of entries) {
        this.dueQueue.schedule(entry.key, entry.nextReconcileAt);
      }
    }
    if (this.closed) throw new Error("plugin Manager is closed");
    this.started = true;
    await Promise.all(
      controllers.map(async (controller) => {
        if (
          this.controllers.get(reconcileScopeId(controller.scope)) !== controller
        ) {
          return;
        }
        await this.activateControllerSources(controller);
        if (
          this.controllers.get(reconcileScopeId(controller.scope)) !== controller
        ) {
          return;
        }
        this.enqueueInitial(controller);
      }),
    );
  }

  private bindRunnerController(instance: PluginInstance, runner: PluginRunnerClient, definition: RemoteRegistration, resources: import("@compforge/aide-plugin").ResourceClient): () => void {
    this.assertControllerResource(instance.pluginInstanceId, definition.resourceType);
    const store = this.resourceStore(instance.pluginInstanceId);
    const scope: ReconcileScope = { controllerName: definition.controllerName, pluginInstanceId: instance.pluginInstanceId, namespace: "v1",
      resourceApiVersion: definition.resourceType.apiVersion, resourceKind: definition.resourceType.kind, };
    const controller = new RunnerController({ scope, registration: definition, runner, store, resources, verb: this.verb,
      snapshot: (key, resource) => this.snapshotFor(key, resource), changed: (change) => this.handlePluginResourceChange(change),
      maxTotalConcurrency: this.remoteConcurrency, retryBackoff: this.retryBackoff });
    const registration = this.installController(controller, true);
    return () => registration.close();
  }

  private async handleControllerRequest(instance: PluginInstance, request: Extract<HostRequest, { method: "controller.begin" | "controller.finish" | "controller.schedule" }>): Promise<unknown> {
    const ref = request.method === "controller.finish" ? request.scope.resourceRef : undefined;
    const key: ReconcileKey = request.method !== "controller.finish" ? request.key : {
      pluginInstanceId: request.scope.pluginInstanceId,
      namespace: request.scope.namespace,
      resourceApiVersion: ref!.apiVersion, resourceKind: ref!.kind, resourceId: ref!.name,
      controllerName: request.scope.controllerName,
    };
    if (key.pluginInstanceId !== instance.pluginInstanceId) throw new Error("Runner Controller scope mismatch");
    const controller = this.controllerForKey(key);
    if (!(controller instanceof RunnerController)) throw new Error(`Unknown Runner Controller: ${key.resourceKind}`);
    if (request.method === "controller.begin") return await controller.begin(key);
    if (request.method === "controller.schedule") return controller.schedule(key, request.nextAt);
    return controller.finish(request.scope, request.resource, request.requeueAfterMs, request.failed);
  }

  private assertControllerResource(pluginInstanceId: string, type: import("@compforge/aide-plugin").ResourceType): void {
    ResourceStorage.open(this.resourceHome).definition(pluginInstanceId, type);
  }

  private bindController<TSpec, TStatus>(
    instance: PluginInstance,
    pluginController: PluginResourceController<TSpec, TStatus>,
  ): () => void {
    this.assertControllerResource(instance.pluginInstanceId, pluginController.resourceType);
    return this.bindPluginResourceController(instance.pluginInstanceId, pluginController);
  }

  private bindPluginResourceController<TSpec, TStatus>(
    pluginInstanceId: string,
    pluginController: PluginResourceController<TSpec, TStatus>,
  ): () => void {
    const store = this.resourceStore(pluginInstanceId);
    const registration = this.registerControllerInternal(
      {
        ...pluginController,
        store,
        now: this.now,
      },
      true,
    );
    return () => registration.close();
  }



  private async closeManager(): Promise<void> {
    await Promise.allSettled(this.activations.values());
    this.verb.failAll("Plugin Manager was closed");
    const errors: unknown[] = [];
    for (const [pluginInstanceId, binding] of [...this.bindings].reverse()) {
      this.bindings.delete(pluginInstanceId);
      try {
        await binding.close();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const controller of this.controllers.values()) controller.close();
    this.controllers.clear();
    this.suspendedControllers.clear();
    this.dueQueue.close();
    this.cronSourceQueue.close();
    this.unsubscribeResourceGc();
    this.unsubscribeWrites?.();
    this.verb.close();
    try {
      await this.pluginSupervisor?.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "could not close plugin Manager");
  }

  private reportActivationFailure(failure: PluginActivationFailure): void {
    this.log?.({
      level: "error",
      source: "aide",
      component: "plugin.activation",
      message: "Plugin activation failed",
      pluginInstanceId: failure.pluginInstanceId,
      error: logError(failure.error),
    });
    try {
      this.onActivationError?.(Object.freeze(failure));
    } catch {
      // Diagnostic reporting must not keep healthy Plugin instances from starting.
    }
  }

  private handlePluginResourceChange(change: ResourceClientChange): void {
    const pending = this.routePluginResourceChange(change);
    this.pendingReconciles.add(pending);
    void pending.finally(() => this.pendingReconciles.delete(pending)).catch(() => {});
  }

  private async routePluginResourceChange(
    change: ResourceClientChange,
  ): Promise<void> {
    if (this.closed) return;

    const pending = new Map<string, {
      controller: ManagedController;
      key: ReconcileKey;
    }>();
    for (const controller of this.controllers.values()) {
      const scopeId = reconcileScopeId(controller.scope);
      if (
        controller.scope.pluginInstanceId !== change.pluginInstanceId ||
        this.suspendedControllers.has(scopeId)
      ) {
        continue;
      }
      if (
        (
          !namespaceContains(
            controller.scope.namespace,
            change.resource.metadata.namespace,
          )
        )
      ) continue;
      let requests;
      try {
        requests = await controller.reconcileKeys(change);
      } catch (error) {
        this.reportWatchFailure(controller.scope, change, error);
        continue;
      }
      for (const request of requests) {
        pending.set(reconcileKeyId(request), { controller, key: request });
      }
    }

    for (const { controller, key } of pending.values()) {
      void this.enqueue(key).catch(() => {
        // Reconcile failures use the Controller retry path; close races need no extra reaction.
      });
    }
  }

  private reportWatchFailure(
    scope: ReconcileScope,
    change: ResourceClientChange,
    error: unknown,
  ): void {
    this.log?.({
      level: "error",
      source: "aide",
      component: "plugin.watch",
      message: "Plugin Controller EventHandler failed",
      pluginInstanceId: scope.pluginInstanceId,
      error: logError(error),
      attributes: {
        primaryResource: `${scope.resourceApiVersion}/${scope.resourceKind}`,
        watchedResource: `${change.resource.apiVersion}/${change.resource.kind}`,
      },
    });
  }

  private writePluginLog(
    instance: PluginInstance,
    record: PluginLogRecord,
  ): void {
    try {
      if (
        !record ||
        typeof record !== "object" ||
        !PLUGIN_LOG_LEVELS.has(record.level)
      ) {
        return;
      }
      const message = typeof record.message === "string"
        ? record.message.trim()
        : "";
      if (!message) return;
      const context = record.context;
      const localComponent = typeof context?.component === "string"
        ? context.component.trim()
        : "";
      this.log?.({
        level: record.level,
        source: "plugin",
        component: localComponent
          ? `plugin.${instance.pluginId}.${localComponent}`
          : `plugin.${instance.pluginId}`,
        message,
        pluginId: instance.pluginId,
        pluginInstanceId: instance.pluginInstanceId,
        packageVersion: instance.packageVersion,
        ...(context?.error === undefined
          ? {}
          : { error: logError(context.error) }),
        ...(context?.attributes &&
            typeof context.attributes === "object" &&
            !Array.isArray(context.attributes)
          ? { attributes: context.attributes }
          : {}),
      });
    } catch {
      // Diagnostics must never affect Plugin activation or reconciliation.
    }
  }

  private handleRunnerFailure(
    pluginInstanceId: string,
    error: Error,
  ): void {
    this.verb.failInstance(pluginInstanceId, error.message);
    this.log?.({
      level: "error",
      source: "aide",
      component: "plugin.runner",
      message: "Plugin Runner stopped unexpectedly",
      pluginInstanceId,
      error: logError(error),
    });
    try {
      this.onRunnerFailure?.({ pluginInstanceId, error });
    } catch {
      // Failure reporting cannot keep a dead Binding registered.
    }
    void (async () => {
      const activation = this.activations.get(pluginInstanceId);
      if (activation) {
        try {
          await activation;
        } catch {
          return;
        }
      }
      await this.deactivateInstance(pluginInstanceId);
    })().catch(() => {
      // Binding close errors are surfaced through diagnostics at their origin.
    });
  }

  private restoreDueReconciles(controller: ManagedController): void {
    for (const entry of controller.scheduledReconciles()) {
      this.dueQueue.schedule(entry.key, entry.nextReconcileAt);
    }
  }

  private installController(
    controller: ManagedController,
    suspended = false,
  ): ControllerRegistration {
    const id = reconcileScopeId(controller.scope);
    if (this.controllers.has(id)) {
      controller.close();
      throw new Error(
        `plugin Controller already registered for ${reconcileScopeLabel(controller.scope)}`,
      );
    }
    this.controllers.set(id, controller);
    if (suspended) this.suspendedControllers.add(id);
    try {
      if (this.started && !suspended) {
        void this.activateControllerSources(controller).then(() => {
          if (this.controllers.get(id) !== controller) return;
          this.restoreDueReconciles(controller);
          this.enqueueInitial(controller);
        });
      }
    } catch (error) {
      this.controllers.delete(id);
      this.suspendedControllers.delete(id);
      controller.close();
      this.dueQueue.removeScope(controller.scope);
      this.cronSourceQueue.removeScope(controller.scope);
      throw error;
    }
    let active = true;
    return Object.freeze({
      close: () => {
        if (!active) return;
        active = false;
        if (this.controllers.get(id) !== controller) return;
        this.controllers.delete(id);
        this.suspendedControllers.delete(id);
        controller.close();
        this.dueQueue.removeScope(controller.scope);
        this.cronSourceQueue.removeScope(controller.scope);
      },
    });
  }

  private enqueueInitial(controller: ManagedController): void {
    for (const key of controller.initialReconciles?.() ?? []) {
      void this.enqueue(key).catch(() => {
        // Queue callback has already scheduled retry and reported diagnostics.
      });
    }
  }

  private async activateControllerSources(
    controller: ManagedController,
  ): Promise<void> {
    const cronSources = controller.cronSources?.() ?? [];
    if (cronSources.length > 0) {
      this.cronSourceQueue.register(controller.scope, cronSources);
    }
    await controller.startSources?.((sourceId, error) => {
      try {
        this.log?.({
          level: "error",
          source: "aide",
          component: "plugin.source",
          message: `Plugin source ${sourceId} failed`,
          pluginInstanceId: controller.scope.pluginInstanceId,
          error: logError(error),
          attributes: {
            resourceApiVersion: controller.scope.resourceApiVersion,
            resourceKind: controller.scope.resourceKind,
            sourceId,
          },
        });
        this.onControllerSourceError?.(Object.freeze({
          scope: controller.scope,
          sourceId,
          error,
        }));
      } catch {
        // Source diagnostics must not interrupt discovery or live delivery.
      }
    });
  }

  private enqueueCronSourceResources(
    scope: ReconcileScope,
    _sources: readonly CronSource[],
  ): void {
    if (!this.started || this.closed) return;
    const controller = this.controllers.get(reconcileScopeId(scope));
    if (
      !controller ||
      this.suspendedControllers.has(reconcileScopeId(scope)) ||
      !sameReconcileScope(controller.scope, scope)
    ) {
      return;
    }
    for (const key of controller.resourceKeys?.() ?? []) {
      void this.enqueue(key).catch(() => {
        // Queue callback has already scheduled retry and reported diagnostics.
      });
    }
  }


  private async resumeControllers(pluginInstanceId: string): Promise<void> {
    for (const controller of this.controllers.values()) {
      if (controller.scope.pluginInstanceId !== pluginInstanceId) continue;
      const id = reconcileScopeId(controller.scope);
      if (!this.suspendedControllers.delete(id)) continue;
      if (this.started) {
        await this.activateControllerSources(controller);
        if (this.controllers.get(id) !== controller) continue;
        this.restoreDueReconciles(controller);
        this.enqueueInitial(controller);
      }
    }
  }

  private reportFailure(failure: ReconcileFailure): void {
    this.log?.({
      level: "error",
      source: "aide",
      component: "plugin.reconcile",
      message: "Plugin reconcile failed",
      pluginInstanceId: failure.key.pluginInstanceId,
      error: logError(failure.error),
      attributes: {
        resourceApiVersion: failure.key.resourceApiVersion,
        resourceKind: failure.key.resourceKind,
        resourceId: failure.key.resourceId,
        attempt: failure.attempt,
        ...(failure.nextRetryAt
          ? { nextRetryAt: failure.nextRetryAt }
          : {}),
      },
    });
    try {
      this.onReconcileError?.(Object.freeze(failure));
    } catch {
      // Diagnostic reporting must not break retry scheduling.
    }
  }
}
