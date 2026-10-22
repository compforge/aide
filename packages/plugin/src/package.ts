import type { ConnectorClient } from "./connectors/index.ts";
import type { Controller } from "./reconcile.ts";
import type { Resource, ResourceClient, ResourceDefinition } from "./resource.ts";
import type { CommandDefinition } from "./command.ts";
import type { Hook, HookStage } from "./hook.ts";
import type { Mention } from "./mention.ts";

export type PluginConfig = Record<string, unknown>;

export interface PluginInstance {
  readonly pluginInstanceId: string;
  readonly aideSessionId: string;
  readonly pluginId: string;
  readonly marketplace?: string;
  readonly packageVersion: string;
  readonly enabled: boolean;
  readonly config: Readonly<PluginConfig>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PluginSessionContext {
  readonly aideSessionId: string;
  readonly cwd?: string;
}

/**
 * Host-created writable directories for Plugin-private files.
 *
 * Scope, rather than Package version, owns each path so upgrades can resume
 * existing state. Resource, Approval, and HarnessInvocation facts still use
 * their host-owned APIs.
 */
export interface PluginDataDirectories {
  /** Shared by this Plugin across all Aide Sessions. */
  readonly global: string;
  /** Private to this Plugin in the current AideSession. */
  readonly session: string;
  /** Private to this concrete Plugin Binding. */
  readonly instance: string;
}

export type ToastTone = "info" | "success" | "warning" | "error";

export interface ToastMessage {
  readonly text: string;
  readonly tone: ToastTone;
}

export interface ToastSink {
  show(message: ToastMessage): void;
}

export type PluginLogLevel = "debug" | "info" | "warn" | "error";

export type PluginLogValue =
  | string
  | number
  | boolean
  | null
  | readonly PluginLogValue[]
  | Readonly<{ [key: string]: PluginLogValue }>;

export type PluginLogAttributes = Readonly<Record<string, PluginLogValue>>;

export interface PluginLogContext {
  /** Stable Plugin-local area, for example "devloop.pull-request-source". */
  readonly component?: string;
  readonly error?: unknown;
  readonly attributes?: PluginLogAttributes;
}

export interface PluginLogger {
  /** Best-effort diagnostics owned, enriched and persisted by the Aide host. */
  debug(message: string, context?: PluginLogContext): void;
  info(message: string, context?: PluginLogContext): void;
  warn(message: string, context?: PluginLogContext): void;
  error(message: string, context?: PluginLogContext): void;
}

export interface PluginRegistry<T> {
  register(value: T): void;
}

export interface PluginControllerRegistry {
  register<TSpec, TStatus>(controller: Controller<TSpec, TStatus>): void;
}

export interface PluginPrinters {
  /** Render a supplied snapshot through its Core or instance Printer; no resource read is performed. */
  describe(resource: Readonly<Resource<unknown, unknown>>): Promise<string>;
  summarize(resource: Readonly<Resource<unknown, unknown>>): Promise<string>;
}

export interface PluginHookRegistry {
  register<S extends HookStage>(hook: Hook<S>): void;
}

export interface PluginLifecycle {
  onClose(cleanup: () => Promise<void> | void): void;
}

export interface PluginContext {
  readonly connectors: ConnectorClient;
  readonly instance: PluginInstance;
  readonly session: PluginSessionContext;
  readonly dataDirs: PluginDataDirectories;
  readonly resources: ResourceClient;
  /** Session-scoped, non-durable user feedback. Reconcile state belongs in Resource status / Board. */
  readonly toast: ToastSink;
  /** Session-scoped structured diagnostics. Never log secrets or use logs as domain state. */
  readonly logger: PluginLogger;
  readonly commands: PluginRegistry<CommandDefinition>;
  readonly mentions: PluginRegistry<Mention>;
  readonly controllers: PluginControllerRegistry;
  readonly printers: PluginPrinters;
  readonly hooks: PluginHookRegistry;
  readonly lifecycle: PluginLifecycle;
}

/**
 * One installable group of Resource schemas, Controllers, Sources, and Connectors.
 *
 * @spec A Plugin Package declares resource scopes per definition; one enabled PluginInstance activates one Worker, while each Resource carries its own namespace.
 */
export interface PluginPackage {
  readonly pluginId: string;
  readonly version: string;
  readonly resources?: readonly ResourceDefinition[];
  activate(context: PluginContext): Promise<void>;
}
