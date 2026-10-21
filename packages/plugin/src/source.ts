import type { ResourceNamespace } from "./namespace.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "./input.ts";
import type { Resource, ResourceClient, ResourceOwnerReference } from "./resource.ts";

/** Input-producing Source identity; distinct from a Controller's resource discovery lifecycle. */
export interface SourceDefinition {
  readonly id: string;
  readonly label: string;
  /** SVG path data in a 24 x 24 viewBox; never markup or a remote URL. */
  readonly icon: string;
}


export type SourceInput = Omit<InputSpec, "origin" | "originId" | "originRef">;

/** @spec A Source-bound input port stamps category and concrete resource identity before durable submission. */
export function bindSourceInput(definition: SourceDefinition, resource: Resource<unknown, unknown>, resources: ResourceClient) {
  const { apiVersion, kind, metadata: { sessionId, namespace, name, uid } } = resource;
  const originRef = { apiVersion, kind, ...(sessionId ? { sessionId } : {}), namespace, name, uid };
  return (inputId: string, spec: SourceInput) => resources.create<InputSpec, InputStatus>(INPUT_TYPE, {
    name: inputId, spec: { ...spec, origin: "source", originId: definition.id, originRef },
  });
}

/** Minimal AbortSignal contract without imposing DOM or Node types on Plugins. */
export interface SourceSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface SourceContext<TSpec> {
  /** Aborted when the owning Controller registration closes. */
  readonly signal: SourceSignal;
  /**
   * Materializes one missing Resource owned by this Controller and enqueues its
   * stable key. Re-emitting the same value is an idempotent wakeup.
   */
  emit(resource: {
    readonly name: string;
    /** Concrete Resource namespace. Defaults to the user-global `v1`. */
    readonly namespace?: ResourceNamespace;
    readonly labels?: Readonly<Record<string, string>>;
    readonly annotations?: Readonly<Record<string, string>>;
    readonly owner?: ResourceOwnerReference;
    readonly spec: TSpec;
  }): Promise<void>;
  /** Reports failures from callbacks that outlive start(). */
  reportError(error: unknown): void;
}

/**
 * Observes external objects and contributes the Resources managed by one
 * Controller.
 */
export interface Source<TSpec = Record<string, unknown>> {
  readonly type: "resource";
  /** Stable within one Controller. */
  readonly sourceId: string;
  /**
   * Performs the initial discovery and installs live subscriptions. Resolve
   * only after both are ready; keep long-lived work behind the abort signal.
   */
  start(context: SourceContext<TSpec>): Promise<void>;
}

/** Aide-owned fixed resync schedule; Plugins do not implement its timer. */
export interface CronSource {
  readonly type: "cron";
  /** Stable within one Controller. */
  readonly sourceId: string;
  /** Five- or six-field cron expression. */
  readonly cron: string;
  /** IANA time zone, for example "Asia/Shanghai" or "UTC". */
  readonly timeZone: string;
}

export type ControllerSource<TSpec = Record<string, unknown>> =
  | Source<TSpec>
  | CronSource;
