import { Controllers } from "./controllers.ts";
import { createConnectorClient } from "../connector-client.ts";
import type {
  CommandDefinition,
  CommandContext,
  CommandInput,
  CommandSubmitInput,
  CommandSubmitReceipt,
  Controller,
  EventHandler,
  Hook,
  HookStage,
  HookSubjectMap,
  Mention,
  PluginContext,
  PluginDataDirectories,
  PluginInstance,
  PluginLogContext,
  PluginLogLevel,
  PluginPackage,
  ReconcileSnapshot,
  PluginSessionContext,
  Resource,
  ResourceClient,
  ResourcePrinter,
  ResourceListOptions,
  ResourceMergePatch,
  ResourceOwnerReference,
  ResourceRef,
  ResourceNamespace,
  ResourceType,
  Source,
  SourceContext,
  ToastMessage,
  Watch,
} from "@compforge/aide-plugin";
import type { PluginLogRecord } from "../protocol/ipc.ts";
import {
  createHookContext,
  createReconcileContext,
} from "../plugin-context.ts";
import {
  type ExecutionScope,
  type VerbResponse,
} from "../protocol/verbs.ts";

import {
  type ActivationResult,
  type ChildCall,
  type ChildMessage,
  type ChildReply,
  type ControllerRegistration,
  type HostRequest,
  type ParentMessage,
  type ParentReply,
  type PluginPackageEntry,
  type PluginRegistration,
  type RunnerRequest,
  restoredError,
  serializedError,
} from "../protocol/ipc.ts";

interface PendingCall {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

const handlers = new Map<string, (...args: never[]) => unknown>();
const cleanups: Array<() => Promise<void> | void> = [];
const pendingHostCalls = new Map<number, PendingCall>();
let nextHandlerId = 1;
let nextHostCallId = 1;
let controllers: Controllers | undefined;
let active = false;
let closing = false;

function send(message: ChildMessage): void {
  if (!process.send) throw new Error("Plugin Runner IPC is unavailable");
  process.send(message);
}

function handler(
  scope: string,
  callback: (...args: never[]) => unknown,
): string {
  const handlerId = `${scope}:${nextHandlerId++}`;
  handlers.set(handlerId, callback);
  return handlerId;
}

function callHost<T>(request: HostRequest): Promise<T> {
  if (closing) {
    return Promise.reject(new Error("Plugin Runner is closing"));
  }
  const callId = nextHostCallId++;
  return new Promise<unknown>((resolve, reject) => {
    pendingHostCalls.set(callId, { resolve, reject });
    try {
      send({
        kind: "child-call",
        callId,
        request,
      } satisfies ChildCall);
    } catch (error) {
      pendingHostCalls.delete(callId);
      reject(error);
    }
  }) as Promise<T>;
}

async function getResource<TSpec, TStatus>(
  ref: ResourceRef,
): Promise<Readonly<Resource<TSpec, TStatus>> | undefined> {
  return await callHost<Readonly<Resource<TSpec, TStatus>> | undefined>({
    method: "resource.get",
    ref,
  });
}

const resources: ResourceClient = Object.freeze({
  get: getResource,
  async list<TSpec, TStatus>(
    type: ResourceType,
    options?: ResourceListOptions,
  ) {
    return await callHost<readonly Readonly<Resource<TSpec, TStatus>>[]>({
      method: "resource.list",
      type,
      options,
    });
  },
  async create<TSpec, TStatus>(
    type: ResourceType,
    init: {
      sessionId?: string;
      name: string;
      namespace?: ResourceNamespace;
      labels?: Readonly<Record<string, string>>;
      annotations?: Readonly<Record<string, string>>;
      owner?: ResourceOwnerReference;
      spec: TSpec;
      status?: TStatus;
    },
  ) {
    return await callHost<Readonly<Resource<TSpec, TStatus>>>({
      method: "resource.create",
      type,
      init,
    });
  },
  async commit(writes: readonly import("@compforge/aide-plugin").ResourceCommit[]) {
    return callHost<Readonly<Resource<unknown, unknown>>[]>({ method: "resource.commit", writes });
  },
  async replace<TSpec, TStatus>(resource: Readonly<Resource<TSpec, TStatus>>, spec: TSpec, status: TStatus) {
    return await callHost<Readonly<Resource<TSpec, TStatus>>>({ method: "resource.replace", resource, spec, status });
  },
  async delete(
    type: ResourceType,
    name: string,
    namespace?: ResourceNamespace,
  ) {
    await callHost<void>({
      method: "resource.delete",
      type,
      name,
      ...(namespace === undefined ? {} : { namespace }),
    });
  },
  async patch<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: ResourceMergePatch,
  ) {
    return await callHost<Readonly<Resource<TSpec, TStatus>>>({
      method: "resource.patch",
      resource: resource as Readonly<Resource<unknown, unknown>>,
      patch,
    });
  },
  async patchMetadata<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: {
      readonly labels?: Readonly<Record<string, string | null>>;
      readonly annotations?: Readonly<Record<string, string | null>>;
    },
  ) {
    return await callHost<Readonly<Resource<TSpec, TStatus>>>({
      method: "resource.patchMetadata",
      resource: resource as Readonly<Resource<unknown, unknown>>,
      patch,
    });
  },
  async patchStatus<TSpec, TStatus>(
    resource: Readonly<Resource<TSpec, TStatus>>,
    patch: Partial<TStatus>,
  ) {
    return await callHost<Readonly<Resource<TSpec, TStatus>>>({
      method: "resource.patchStatus",
      resource: resource as Readonly<Resource<unknown, unknown>>,
      patch: patch as Readonly<Record<string, unknown>>,
    });
  },
});

function commandRegistration(command: CommandDefinition): PluginRegistration {
  return {
    input: command.input,
    aliases: command.aliases,
    runPolicy: command.runPolicy,
    scope: command.scope,
    kind: "command",
    handlerId: handler(
      `command:${command.name}`,
      (async (input: CommandInput, snapshot: Omit<CommandContext, "verbs">) => {
        let active = true;
        const invoke = (request: HostRequest) => {
          if (!active) throw new Error("Command execution is no longer active");
          return callHost(request);
        };
        try {
          return await command.execute(input, Object.freeze({
            ...snapshot,
            verbs: Object.freeze({
              submit: async (input: CommandSubmitInput) =>
                await invoke({ method: "command.verb", executionId: snapshot.executionId, verb: "submit", input }) as CommandSubmitReceipt,
              configureModel: async (input: { model?: string; effort?: string }) => {
                await invoke({ method: "command.verb", executionId: snapshot.executionId, verb: "configureModel", input });
              },
            }),
          }));
        } finally { active = false; }
      }) as (...args: never[]) => unknown,
    ),
    name: command.name,
    description: command.description,
  };
}

function mentionRegistration(mention: Mention): PluginRegistration {
  return {
    kind: "mention",
    namespace: mention.namespace,
    searchHandlerId: handler(
      `mention:${mention.namespace}:search`,
      mention.search.bind(mention) as (...args: never[]) => unknown,
    ),
    resolveHandlerId: handler(
      `mention:${mention.namespace}:resolve`,
      mention.resolve.bind(mention) as (...args: never[]) => unknown,
    ),
  };
}

function hookRegistration(hook: Hook): PluginRegistration {
  return {
    kind: "hook",
    hookId: hook.hookId,
    stage: hook.stage,
    ...(hook.timeoutMs === undefined ? {} : { timeoutMs: hook.timeoutMs }),
    handlerId: handler(
      `hook:${hook.stage}:${hook.hookId}`,
      (async <S extends HookStage>(
        stage: S,
        subject: Readonly<HookSubjectMap[S]>,
        snapshot: ReconcileSnapshot,
        context: ExecutionScope,
      ) =>
        await hook.run(
          createHookContext(
            stage,
            subject,
            snapshot,
            context,
            async (verbContext, request) =>
              await callHost<VerbResponse>({
                method: "verb.invoke",
                context: verbContext,
                request,
              }),
          ),
        )) as (...args: never[]) => unknown,
    ),
  };
}

function printerRegistration(printer: ResourcePrinter): PluginRegistration {
  const print = (method: "describe" | "summarize") => handler(`printer:${method}`,
    ((resource: Resource<unknown, unknown>) => {
      const value = printer[method](resource);
      if (typeof value !== "string") throw new Error(`Resource Printer ${method} must return a string synchronously`);
      return value;
    }) as (...args: never[]) => unknown);
  return { kind: "printer", resourceType: printer.resourceType,
    describeHandlerId: print("describe"), summarizeHandlerId: print("summarize") };
}

function controllerRegistration(controller: Controller<unknown, unknown>): ControllerRegistration {
  return {
    kind: "controller", controllerId: `controller:${controller.resourceType.apiVersion}:${controller.resourceType.kind}${controller.name ? `:${controller.name}` : ""}`,
    ...(controller.name ? { controllerName: controller.name } : {}),
    resourceType: controller.resourceType,
    ...(controller.present ? { presentHandlerId: handler("controller:present", controller.present.bind(controller) as (...args: never[]) => unknown) } : {}),
  };
}

async function activate(
  entry: PluginPackageEntry,
  instance: PluginInstance,
  session: PluginSessionContext,
  dataDirs: PluginDataDirectories,
): Promise<ActivationResult> {
  if (active) throw new Error("Plugin Runner already has an active Binding");
  if (closing) throw new Error("Plugin Runner is closing");
  const module = await import(entry.entryUrl) as { default?: unknown };
  const plugin = module.default as PluginPackage | undefined;
  if (!plugin || typeof plugin.activate !== "function") {
    throw new Error(`Plugin entry must default export a PluginPackage: ${entry.entryUrl}`);
  }
  if (plugin.pluginId !== entry.pluginId || plugin.version !== entry.version) {
    throw new Error(
      `loaded Package identity ${plugin.pluginId}@${plugin.version} does not match ${entry.pluginId}@${entry.version}`,
    );
  }
  controllers = new Controllers(session, instance.pluginInstanceId, resources, callHost, pluginLogger());
  const registrations: PluginRegistration[] = [];
  let sealed = false;
  const assertRegistering = (): void => {
    if (sealed) throw new Error("Plugin Binding activation is complete");
  };
  const context: PluginContext = Object.freeze({
    instance,
    session,
    dataDirs: Object.freeze({ ...dataDirs }),
    resources,
    connectors: createConnectorClient((request) => callHost({ method: "connector.read", request })),
    toast: Object.freeze({
      show(message: ToastMessage) {
        send({ kind: "toast", message });
      },
    }),
    logger: pluginLogger(),
    commands: Object.freeze({
      register(command: CommandDefinition) {
        assertRegistering();
        registrations.push(commandRegistration(command));
      },
    }),
    mentions: Object.freeze({
      register(mention: Mention) {
        assertRegistering();
        registrations.push(mentionRegistration(mention));
      },
    }),
    controllers: Object.freeze({
      register<TSpec, TStatus>(controller: Controller<TSpec, TStatus>) {
        assertRegistering();
        const registration = controllerRegistration(controller as Controller<unknown, unknown>);
        controllers!.register((registration as ControllerRegistration).controllerId, controller as Controller<unknown, unknown>);
        registrations.push(registration);
      },
    }),
    printers: Object.freeze({
      describe: (resource: Readonly<Resource<unknown, unknown>>) => callHost<string>({ method: "printer.describe", resource }),
      summarize: (resource: Readonly<Resource<unknown, unknown>>) => callHost<string>({ method: "printer.summarize", resource }),
      register<TSpec, TStatus>(printer: ResourcePrinter<TSpec, TStatus>) {
        assertRegistering();
        registrations.push(printerRegistration(printer as ResourcePrinter));
      },
    }),
    hooks: Object.freeze({
      register(hook: Hook) {
        assertRegistering();
        registrations.push(hookRegistration(hook));
      },
    }),
    lifecycle: Object.freeze({
      onClose(cleanup: () => Promise<void> | void) {
        assertRegistering();
        cleanups.push(cleanup);
      },
    }),
  });
  try {
    await plugin.activate(context);
    sealed = true;
    active = true;
    return {
      registrations: Object.freeze(registrations),
    };
  } catch (error) {
    sealed = true;
    await closeBinding();
    throw error;
  }
}

function pluginLogger(): PluginContext["logger"] {
  const write = (
    level: PluginLogLevel,
    message: string,
    context?: PluginLogContext,
  ): void => {
    try {
      const record: PluginLogRecord = {
        level,
        message,
        ...(context ? { context } : {}),
      };
      send({ kind: "log", record });
    } catch {
      // Logging is best-effort and must not change Plugin behavior.
    }
  };
  return Object.freeze({
    debug: (message: string, context?: PluginLogContext) =>
      write("debug", message, context),
    info: (message: string, context?: PluginLogContext) =>
      write("info", message, context),
    warn: (message: string, context?: PluginLogContext) =>
      write("warn", message, context),
    error: (message: string, context?: PluginLogContext) =>
      write("error", message, context),
  });
}

async function closeBinding(): Promise<void> {
  if (closing) return;
  closing = true;
  controllers?.close();
  const errors: unknown[] = [];
  for (const cleanup of cleanups.reverse()) {
    try {
      await cleanup();
    } catch (error) {
      errors.push(error);
    }
  }
  cleanups.length = 0;
  handlers.clear();
  for (const pending of pendingHostCalls.values()) {
    pending.reject(new Error("Plugin Runner is closing"));
  }
  pendingHostCalls.clear();
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(errors, "Could not close Plugin Runner");
  }
}

async function dispatch(request: RunnerRequest): Promise<unknown> {
  switch (request.method) {
    case "controllers.settled": return await controllers!.settled();
    case "controller.start":
      return await controllers!.start(request.controllerId, request.maxTotalConcurrency, request.retryBackoff);
    case "controller.enqueue":
      return await controllers!.enqueue(request.controllerId, request.key);
    case "controller.change":
      return await controllers!.changed(request.controllerId, request.change);
    case "controller.stop":
      return controllers!.stop(request.controllerId);

    case "activate":
      return await activate(
        request.entry,
        request.instance,
        request.session,
        request.dataDirs,
      );
    case "invoke": {
      const callback = handlers.get(request.handlerId);
      if (!callback) throw new Error(`Unknown Plugin handler: ${request.handlerId}`);
      return await callback(...request.args as never[]);
    }
    case "close":
      await closeBinding();
      return undefined;
  }
}

function handleParentReply(reply: ParentReply): void {
  const pending = pendingHostCalls.get(reply.callId);
  if (!pending) return;
  pendingHostCalls.delete(reply.callId);
  if (reply.ok) pending.resolve(reply.value);
  else pending.reject(restoredError(reply.error));
}

process.on("message", (message: ParentMessage) => {
  if (message.kind === "parent-reply") {
    handleParentReply(message);
    return;
  }
  void dispatch(message.request).then(
    (value) => {
      send({
        kind: "child-reply",
        callId: message.callId,
        ok: true,
        value,
      } satisfies ChildReply);
      if (message.request.method === "close") {
        process.disconnect?.();
      }
    },
    (error) => {
      send({
        kind: "child-reply",
        callId: message.callId,
        ok: false,
        error: serializedError(error),
      } satisfies ChildReply);
    },
  );
});

process.on("disconnect", () => {
  void closeBinding().finally(() => process.exit(0));
});
