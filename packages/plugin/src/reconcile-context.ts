import type { ConnectorClient } from "./connectors/index.ts";
import type { ResourceRef } from "./resource.ts";
import type { ReconcileSnapshot, TurnSummary } from "./snapshot.ts";

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
  readonly title: string;
  readonly prompt: string;
  /** Existing Aide Lane to continue, including the reserved main Lane ID `main`. */
  readonly laneId?: string;
  /** Create a new side Lane from laneId instead of continuing it. Defaults to false. */
  readonly newLane?: boolean;
  /** Replace this target native context with the supplied bounded prompt; never replay old turns. */
  readonly freshContext?: boolean;
  /** Omit to use the host's selected HarnessTarget when scheduling. */
  readonly harnessTargetId?: string;
}

export interface CompletedHarnessValue {
  readonly outcome: "completed";
  readonly laneId: string;
  readonly turn: TurnSummary;
}

export type HarnessValue = CompletedHarnessValue;

export type HarnessResult = VerbResult<HarnessValue>;

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
}

export interface ExecutionAssociation {
  readonly resourceRef?: ResourceRef;
  readonly conversationId?: string;
  readonly inputId?: string;
  readonly inputIds?: readonly string[];
}

export interface ReconcileContext {
  /** Core identity of this live execution, including its associated verb calls. */
  readonly executionId: string;
  /** Associate subsequent actions with business input, independently of Harness selection. */
  withContext(context: Pick<ExecutionAssociation, "conversationId" | "inputId" | "inputIds">): ReconcileContext;
  readonly snapshot: ReconcileSnapshot;
  readonly verbs: PluginVerbs;
}
