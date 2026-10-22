import type { Address } from "./address.ts";
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

/** Persists a message for Channel delivery; success does not mean the recipient has read it. */
export interface SayInput {
  readonly text: string;
  readonly inputIds?: readonly string[];
  readonly idempotencyKey?: string;
  readonly respondToInputId?: string;
  readonly target?: Address;
  /** Person references; explicit [] suppresses inference from respondToInputId's sender. */
  readonly receivers?: readonly ResourceRef[];
}
export type SayResult = VerbResult<{ readonly outputId: string }>;

/** A Plugin request that creates a Core-owned HarnessInvocation. */
export interface HarnessInvocationInput extends VerbInput {
  readonly title: string;
  readonly prompt: string;
  /** Existing Aide Lane to continue, including the reserved main Lane ID `main`. */
  readonly laneId: string;
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
 * @rule Waiting verbs require one total timeout; say only persists a message without waiting for delivery; harness deadlines cover the HarnessInvocation through terminal Turn.
 * @see {@link docs/plugin.md}
 */
export interface PluginVerbs {
  say(input: SayInput): Promise<SayResult>;
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
