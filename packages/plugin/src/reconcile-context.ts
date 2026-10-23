import type { ConnectorClient } from "./connectors/index.ts";
import type { ResourceRef } from "./resource.ts";
import type { ReconcileSnapshot, HarnessExecutionResult } from "./snapshot.ts";

/** Largest timeout supported by JavaScript timers. */
export const MAX_VERB_TIMEOUT_MS = 2_147_483_647 as const;

/**
 * @spec Every Plugin verb has exactly four terminal outcomes: success with a business value, explicit user dismissal, deadline timeout, or execution failure.
 * @rule Cancellation is dismissed; a deadline is timeout. Neither proves that external effects were undone.
 */
export type VerbResult<T> =
  | { readonly state: "success"; readonly value: T }
  | { readonly state: "dismissed" }
  | { readonly state: "timeout" }
  | { readonly state: "failure"; readonly error?: string };

interface VerbInput {
  /** Maximum time Aide may wait; must be between 1 and MAX_VERB_TIMEOUT_MS. */
  readonly timeoutMs: number;
}

/** A Plugin request that creates a Core-owned HarnessInvocation. */
export interface HarnessInvocationInput extends VerbInput {
  readonly operation?: "prompt";
  readonly prompt: string;
  readonly title: string;
  /** Native session identity supplied by the caller; the verb never reads resource status. */
  readonly sessionId?: string;
  /** Omit to use the application's configured default HarnessConfiguration. */
  readonly harness?: string;
}

export interface CompletedHarnessValue {
  readonly outcome: "completed";
  readonly invocationId: string;
  readonly result: HarnessExecutionResult;
}

export type HarnessValue = CompletedHarnessValue;

export type HarnessResult = VerbResult<HarnessValue> & { readonly agent?: import("./harness.ts").AgentStatus };

/** A receipt acknowledges an operation, never completion of its business inputs. */
export interface HarnessOperationValue {
  readonly outcome: "accepted" | "rejected";
  readonly reason?: string;
  readonly sessionId?: string;
}
interface HarnessOperationOptions extends VerbInput {
  readonly harness?: string;
}
export type HarnessOperationInput = HarnessOperationOptions & (
  | { readonly operation: "create" }
  | { readonly operation: "close"; readonly sessionId: string }
  | { readonly operation: "abort"; readonly invocationId: string }
  | { readonly operation: "resume"; readonly sessionId: string }
  | { readonly operation: "followUp" | "steer"; readonly invocationId: string; readonly messageId: string; readonly prompt: string }
);
export type HarnessVerbInput = HarnessInvocationInput | HarnessOperationInput;
export type HarnessOperationResult = VerbResult<HarnessOperationValue> & { readonly agent?: import("./harness.ts").AgentStatus };

/**
 * @spec Controller verbs suspend the same live Plugin execution until a terminal result; Aide never re-enqueues a Resource merely to deliver that result.
 * @rule Correlate verb continuation with the Core-issued execution identity, never with Resource identity or a caller-provided key; a crashed execution fails instead of replaying its call stack.
 * @rule Harness and Connector verbs require one total timeout; action completion follows the application capability contract.
 * @see {@link docs/plugin/README.md}
 */
export interface PluginVerbs {
  action<T = unknown>(name: string, input: unknown): Promise<VerbResult<T>>;
  connectors(options: { timeoutMs: number }): ConnectorClient;
  harness(input: HarnessInvocationInput): Promise<HarnessResult>;
  harness(input: HarnessOperationInput): Promise<HarnessOperationResult>;
}

export interface ExecutionAssociation {
  readonly resourceRef?: ResourceRef;
  /** Opaque application-owned correlation metadata; the runtime only persists it. */
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface ReconcileContext {
  /** Core identity of this live execution, including its associated verb calls. */
  readonly executionId: string;
  /** Attach application metadata to subsequent actions without changing resource ownership. */
  withContext(attributes: Readonly<Record<string, unknown>>): ReconcileContext;
  readonly snapshot: ReconcileSnapshot;
  readonly verbs: PluginVerbs;
}
