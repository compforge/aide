import type { RuntimeScope } from "../../protocol/runtime.ts";
import type { ConnectorClient } from "@compforge/aide-plugin";
import type { ConnectorRequest } from "../../protocol/connectors.ts";
import { createConnectorClient, dispatchConnector, emptyConnectors } from "../../connector-client.ts";
import type { PluginLogRecord } from "../../protocol/ipc.ts";
import type { DeferredHookStage, Hook, HookStage, HookSubjectMap, InlineHookStage, Controller, ControllerSource, CronSource, CreateEvent, DeleteEvent, EventHandler, EventResource, MapFunc, PluginContext, PluginDataDirectories, PluginLogContext, PluginLogger, PluginLogLevel, PluginPackage, Resource, ReconcileRequest, ResourceRef, Source, SourceContext, SourceSignal, ResourceType, ResourceMergePatch, UpdateEvent, Watch } from "@compforge/aide-plugin";
import type { PluginInstance } from "./instance.ts";
import type { ResourceClient } from "./resource/client.ts";
import { validateResourceType } from "./resource/type.ts";

export type { DeferredHookStage, Hook, HookStage, HookSubjectMap, InlineHookStage, Controller, ControllerSource, CronSource, CreateEvent, DeleteEvent, EventHandler, EventResource, MapFunc, PluginContext, PluginDataDirectories, PluginLogContext, PluginLogger, PluginLogLevel, PluginPackage, Resource, ReconcileRequest, ResourceRef, Source, SourceContext, SourceSignal, ResourceType, ResourceMergePatch, UpdateEvent, Watch } from "@compforge/aide-plugin";

function uniqueRequests(
  requests: readonly ReconcileRequest[],
): readonly ReconcileRequest[] {
  const unique = new Map<string, ReconcileRequest>();
  for (const request of requests) {
    const key = JSON.stringify([request.namespace, request.name]);
    if (!unique.has(key)) unique.set(key, request);
  }
  return Object.freeze([...unique.values()]);
}

function typedResource<TSpec, TStatus>(
  resource: EventResource,
): Readonly<Resource<TSpec, TStatus>> {
  return resource as Readonly<Resource<TSpec, TStatus>>;
}

/** Internal convenience adapter; the public authoring package stays type-only. */
export function enqueueRequestsFromMapFunc<
  TSpec = unknown,
  TStatus = unknown,
>(
  map: MapFunc<TSpec, TStatus>,
): EventHandler {
  return Object.freeze({
    async create(event: CreateEvent) {
      return uniqueRequests(
        await map(typedResource<TSpec, TStatus>(event.object)),
      );
    },
    async update(event: UpdateEvent) {
      return uniqueRequests([
        ...await map(typedResource<TSpec, TStatus>(event.oldObject)),
        ...await map(typedResource<TSpec, TStatus>(event.newObject)),
      ]);
    },
    async delete(event: DeleteEvent) {
      return uniqueRequests(
        await map(typedResource<TSpec, TStatus>(event.object)),
      );
    },
  });
}

type ResourceRegistrar = <TSpec, TStatus>(
  controller: Controller<TSpec, TStatus>,
) => () => void;

type HookRegistrar = (
  hook: Hook,
) => () => void;

interface PluginRegistrars {
  describeResource(resource: Readonly<Resource<unknown, unknown>>): Promise<string>;
  summarizeResource(resource: Readonly<Resource<unknown, unknown>>): Promise<string>;
  registerHook: HookRegistrar;
  registerController: ResourceRegistrar;
  writeLog(record: PluginLogRecord): void;
}


function nonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

export function pluginPackageKey(pluginId: string, version: string): string {
  return JSON.stringify([pluginId, version]);
}

export function validatePluginPackage(plugin: PluginPackage): void {
  nonEmpty("pluginId", plugin.pluginId);
  nonEmpty("plugin version", plugin.version);
  if (typeof plugin.activate !== "function") {
    throw new Error(`plugin Package ${plugin.pluginId}@${plugin.version} must provide activate()`);
  }
}

/**
 * PluginInstance 在当前进程中的一次临时绑定。所有注册按逆序关闭，支持激活失败整体回滚。
 */
export class PluginBinding implements PluginContext {
  readonly instance: import("@compforge/aide-plugin").PluginInstance;
  readonly runtime: import("@compforge/aide-plugin").PluginRuntimeContext;
  readonly dataDirs: PluginDataDirectories;
  readonly resources: ResourceClient;
  readonly connectors: ConnectorClient;
  readonly logger: PluginLogger;
  readonly controllers: PluginContext["controllers"];
  readonly printers: PluginContext["printers"];
  readonly hooks: PluginContext["hooks"];
  readonly lifecycle: PluginContext["lifecycle"];
  private readonly registrars: PluginRegistrars;
  private readonly cleanups: Array<() => Promise<void> | void> = [];
  private sealed = false;
  private closed = false;
  private closing?: Promise<void>;

  constructor(
    instance: PluginInstance,
    runtime: RuntimeScope,
    dataDirs: PluginDataDirectories,
    registrars: PluginRegistrars,
    resources: ResourceClient,
    connectors: ConnectorClient = emptyConnectors,
  ) {
    const publicInstance = instance;
    this.instance = Object.freeze(publicInstance);
    this.runtime = Object.freeze({ ...(runtime.cwd ? { cwd: runtime.cwd } : {}) });
    this.dataDirs = Object.freeze({ ...dataDirs });
    this.registrars = registrars;
    this.resources = resources;
    this.connectors = createConnectorClient(async <T>(request: ConnectorRequest): Promise<T> => {
      if (this.closed) throw new Error("plugin Binding is closed");
      return await dispatchConnector(connectors, request) as T;
    });
    const write = (
      level: PluginLogLevel,
      message: string,
      context?: PluginLogContext,
    ): void => {
      if (this.closed) throw new Error("plugin Binding is closed");
      this.registrars.writeLog({
        level,
        message,
        ...(context ? { context } : {}),
      });
    };
    this.logger = Object.freeze({
      debug: (message: string, context?: PluginLogContext) =>
        write("debug", message, context),
      info: (message: string, context?: PluginLogContext) =>
        write("info", message, context),
      warn: (message: string, context?: PluginLogContext) =>
        write("warn", message, context),
      error: (message: string, context?: PluginLogContext) =>
        write("error", message, context),
    });
    this.controllers = Object.freeze({
      register: <TSpec, TStatus>(controller: Controller<TSpec, TStatus>) =>
        this.registerController(controller),
    });
    this.printers = Object.freeze({
      describe: (resource: Readonly<Resource<unknown, unknown>>) => this.registrars.describeResource(resource),
      summarize: (resource: Readonly<Resource<unknown, unknown>>) => this.registrars.summarizeResource(resource),
    });
    this.hooks = Object.freeze({
      register: (hook: Hook) => this.registerHook(hook),
    });
    this.lifecycle = Object.freeze({
      onClose: (cleanup: () => Promise<void> | void) =>
        this.registerCleanup(cleanup),
    });
  }

  completeActivation(): void {
    if (this.closed) throw new Error("plugin Binding is closed");
    this.sealed = true;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.sealed = true;
    const closing = this.closeAll();
    this.closing = closing;
    return closing;
  }

  private assertRegistering(): void {
    if (this.closed) throw new Error("plugin Binding is closed");
    if (this.sealed) throw new Error("plugin Binding activation is complete");
  }

  private registerController<TSpec, TStatus>(controller: Controller<TSpec, TStatus>): void {
    this.assertRegistering();
    validateResourceType(controller.resourceType);
    this.cleanups.push(this.registrars.registerController(controller));
  }

  private registerHook(hook: Hook): void {
    this.assertRegistering();
    this.cleanups.push(this.registrars.registerHook(hook));
  }

  private registerCleanup(cleanup: () => Promise<void> | void): void {
    this.assertRegistering();
    if (typeof cleanup !== "function") throw new Error("plugin cleanup must be a function");
    this.cleanups.push(cleanup);
  }

  private async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const cleanup of this.cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    this.cleanups.length = 0;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "could not close plugin Binding");
  }
}
