import type { ReconcileSnapshot } from "./snapshot.ts";
import type { PluginVerbs } from "./reconcile-context.ts";

export type HookStage =
  | "harness.input"
  | "harness.output";

/** Hook stages completed inline before Core continues the observed operation. */
export type InlineHookStage =
  | "harness.input";

/** Durable or published observations delivered through the best-effort queue. */
export type DeferredHookStage = Exclude<HookStage, InlineHookStage>;

/** Read-only view of one Core dispatch of a HarnessInput to its Adapter. */
export interface HarnessInputDispatch {
  readonly attemptId: string;
  readonly harnessName: string;
  readonly invocationId: string;
  readonly messageId: string;
  readonly operation: "new_turn" | "steer" | "followUp";
}

/** Reference to a Harness-originated Aide Event after Core commits it. */
export interface AideEventReference {
  readonly kind: string;
  readonly harnessName: string;
  readonly invocationId?: string;
  readonly eventId: string;
  readonly seq: number;
}

export interface HookSubjectMap {
  /** Boundary observations, not Hook arguments paired with a Hook return value. */
  readonly "harness.input": HarnessInputDispatch;
  readonly "harness.output": AideEventReference;
}

/**
 * One live Hook execution. Hook handlers have no decision/output channel;
 * effects must use typed Core verbs.
 */
export interface HookContext<S extends HookStage = HookStage> {
  readonly stage: S;
  readonly subject: Readonly<HookSubjectMap[S]>;
  readonly snapshot: ReconcileSnapshot;
  readonly verbs: Omit<PluginVerbs, "harness">;
}

export interface Hook<S extends HookStage = HookStage> {
  readonly hookId: string;
  readonly stage: S;
  /** Optional watchdog for this handler. Defaults to the host policy. */
  readonly timeoutMs?: number;
  run(context: HookContext<S>): Promise<void> | void;
}
