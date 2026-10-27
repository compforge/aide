import type { RuntimeScope } from "./runtime.ts";
import type { ReconcileKey } from "./reconcile.ts";
import type { ConnectorRequest } from "./connectors.ts";
import type { PluginDataDirectories, PluginInstance, PluginLogLevel, PluginLogContext, HookStage, Resource, ResourceListOptions, ResourceMergePatch, ResourceOwnerReference, ResourceRef, ResourceNamespace, ResourceType } from "@compforge/aide-plugin";
import type {
  ExecutionScope,
  VerbRequest,
} from "./verbs.ts";

export interface PluginLogRecord {
  readonly level: PluginLogLevel;
  readonly message: string;
  readonly context?: PluginLogContext;
}

export interface PluginPackageEntry {
  readonly pluginId: string;
  readonly version: string;
  readonly entryUrl: string;
  /** Pure resource declarations loaded in Host separately from the Runner activation entry. */
  readonly resourcesUrl?: string;
}

export interface HookRegistration {
  readonly kind: "hook";
  readonly hookId: string;
  readonly stage: HookStage;
  readonly timeoutMs?: number;
  readonly handlerId: string;
}


export interface ControllerRegistration {
  readonly controllerName?: string;
  readonly kind: "controller";
  readonly controllerId: string;
  readonly resourceType: ResourceType;
}

export type PluginRegistration =
  | HookRegistration
  | ControllerRegistration;

export interface ActivationResult {
  readonly registrations: readonly PluginRegistration[];
}

export type RunnerRequest =
  | { readonly method: "controllers.settled" }
  | { readonly method: "controller.start"; readonly controllerId: string; readonly maxTotalConcurrency: number; readonly retryBackoff: { initialDelayMs: number; maxDelayMs: number } }
  | { readonly method: "controller.enqueue"; readonly controllerId: string; readonly key: ReconcileKey }
  | { readonly method: "controller.change"; readonly controllerId: string; readonly change: { kind: string; resource: Resource<unknown, unknown>; oldResource?: Resource<unknown, unknown> } }
  | { readonly method: "controller.stop"; readonly controllerId: string }

  | {
      readonly method: "activate";
      readonly entry: PluginPackageEntry;
      readonly instance: PluginInstance;
      readonly runtime: RuntimeScope;
      readonly dataDirs: PluginDataDirectories;
    }
  | {
      readonly method: "invoke";
      readonly handlerId: string;
      readonly args: readonly unknown[];
    }
  | {
      readonly method: "close";
    };

export type HostRequest =
  | { readonly method: "printer.describe" | "printer.summarize"; readonly resource: Readonly<Resource<unknown, unknown>> }
  | { readonly method: "controller.begin"; readonly key: ReconcileKey }
  | { readonly method: "controller.finish"; readonly scope: ExecutionScope; readonly resource: Resource<unknown, unknown>; readonly requeueAfterMs?: number; readonly failed?: string }
  | { readonly method: "controller.schedule"; readonly key: ReconcileKey; readonly nextAt: string }

  | { readonly method: "resource.commit"; readonly writes: readonly import("@compforge/aide-plugin").ResourceCommit[] }
  | { readonly method: "resource.replace"; readonly resource: Resource<unknown, unknown>; readonly spec: unknown; readonly status: unknown }
  | { readonly method: "connector.request"; readonly request: ConnectorRequest }
  | {
      readonly method: "verb.invoke";
      readonly context: ExecutionScope;
      readonly request: VerbRequest;
    }
  | {
      readonly method: "resource.get";
      readonly ref: ResourceRef;
    }
  | {
      readonly method: "resource.list";
      readonly type: ResourceType;
      readonly options?: ResourceListOptions;
    }
  | {
      readonly method: "resource.create";
      readonly type: ResourceType;
      readonly init: {
        readonly name: string;
        readonly namespace?: ResourceNamespace;
        readonly labels?: Readonly<Record<string, string>>;
        readonly annotations?: Readonly<Record<string, string>>;
        readonly owner?: ResourceOwnerReference;
        readonly spec: unknown;
        readonly status?: unknown;
      };
    }
  | {
      readonly method: "resource.delete";
      readonly type: ResourceType;
      readonly name: string;
      readonly namespace?: ResourceNamespace;
      readonly preconditions?: { readonly uid: string; readonly resourceVersion: string };
    }
  | {
      readonly method: "resource.patch";
      readonly resource: Readonly<Resource<unknown, unknown>>;
      readonly patch: ResourceMergePatch;
    }
  | {
      readonly method: "resource.patchMetadata";
      readonly resource: Readonly<Resource<unknown, unknown>>;
      readonly patch: {
        readonly labels?: Readonly<Record<string, string | null>>;
        readonly annotations?: Readonly<Record<string, string | null>>;
      };
    }
  | {
      readonly method: "resource.patchStatus";
      readonly resource: Readonly<Resource<unknown, unknown>>;
      readonly patch: Readonly<Record<string, unknown>>;
    };

export interface RunnerSignal {
  readonly kind: "log";
  readonly record: PluginLogRecord;
}

export interface SerializedError {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly cause?: SerializedError;
}

export interface ParentCall {
  readonly kind: "parent-call";
  readonly callId: number;
  readonly request: RunnerRequest;
}

export type ChildReply =
  | {
      readonly kind: "child-reply";
      readonly callId: number;
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly kind: "child-reply";
      readonly callId: number;
      readonly ok: false;
      readonly error: SerializedError;
    };

export interface ChildCall {
  readonly kind: "child-call";
  readonly callId: number;
  readonly request: HostRequest;
}

export type ParentReply =
  | {
      readonly kind: "parent-reply";
      readonly callId: number;
      readonly ok: true;
      readonly value: unknown;
    }
  | {
      readonly kind: "parent-reply";
      readonly callId: number;
      readonly ok: false;
      readonly error: SerializedError;
    };

export type ParentMessage =
  | ParentCall
  | ParentReply;

export type ChildMessage =
  | ChildReply
  | ChildCall
  | RunnerSignal;

export function serializedError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack === undefined ? {} : { stack: error.stack }),
      ...(error.cause === undefined
        ? {}
        : { cause: serializedError(error.cause) }),
    };
  }
  return {
    name: "Error",
    message: String(error),
  };
}

export function restoredError(error: SerializedError): Error {
  const restored = new Error(
    error.message,
    error.cause === undefined
      ? undefined
      : { cause: restoredError(error.cause) },
  );
  restored.name = error.name;
  if (error.stack !== undefined) restored.stack = error.stack;
  return restored;
}
