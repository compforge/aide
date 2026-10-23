import type { ExecutionAssociation } from "@compforge/aide-plugin";
import type { HarnessExecutionResult } from "@compforge/aide-plugin";
type InvocationSummary = HarnessExecutionResult & { readonly invocationId: string };

import { newId } from "../event/ids.ts";
import type {
  AnyEventEnvelope,
  EventEnvelope,
  HarnessInvocationCancelled,
  HarnessInvocationFailed,
  HarnessInvocationScheduled,
  PromptBlock,
} from "../event/index.ts";
import { RECENT_INVOCATIONS, type HarnessActivity } from "./activity.ts";
import type {
  ExecutionScope,
} from "../../protocol/verbs.ts";

export type HarnessInvocationPhase =
  | "queued"
  | "running"
  | "uncertain"
  | "completed"
  | "cancelled"
  | "failed";

export interface HarnessInvocationSnapshot extends ExecutionAssociation {
  readonly invocationId: string;
  readonly executionId: string;
  readonly verb: "harness";
  readonly phase: HarnessInvocationPhase;
  readonly freshContext?: boolean;
  readonly harnessTargetId: string;
  readonly contextId?: string;
  readonly result?: InvocationSummary;
  readonly cancellation?: Readonly<HarnessInvocationCancelled>;
  readonly failure?: Readonly<HarnessInvocationFailed>;
}

export interface ReconcileHarnessInvocation {
  readonly scope: ExecutionScope;
  readonly invocation: {
    readonly verb: "harness";
    readonly title: string;
    readonly prompt: string;
    readonly contextId: string;
    readonly freshContext?: boolean;
    readonly harnessTargetId: string;
  };
}

type HarnessInvocationRecords = Pick<
  HarnessActivity,
  "appendEvent" | "subscribe" | "requireExecutionContext"
>;

export interface ScheduledHarnessInvocation {
  readonly invocationId: string;
  readonly pluginInstanceId: string;
  readonly harnessTargetId: string;
  readonly contextId: string;
  readonly freshContext?: boolean;
  readonly source: "user" | "plugin";
  readonly messageId: string;
  readonly blocks: readonly PromptBlock[];
}

interface InvocationState {
  readonly recorded: EventEnvelope<"_aide_harness_invocation_recorded">;
  scheduled?: EventEnvelope<"_aide_harness_invocation_scheduled">;
  cancelled?: EventEnvelope<"_aide_harness_invocation_cancelled">;
  failed?: EventEnvelope<"_aide_harness_invocation_failed">;
  admitted: boolean;
  uncertain: boolean;
  result?: InvocationSummary;
}

export interface HarnessInvocationsOptions {
  onChanged?(invocation: HarnessInvocationSnapshot): void;
}

function pluginInstanceIdOf(state: InvocationState): string {
  const source = state.recorded.source;
  if (source.type !== "plugin") {
    throw new Error(
      `HarnessInvocation ${state.recorded.payload.invocationId} has a non-Plugin source`,
    );
  }
  return source.pluginInstanceId;
}

function phaseOf(state: InvocationState): HarnessInvocationPhase {
  if (state.result) return "completed";
  if (state.failed) return "failed";
  if (state.cancelled) return "cancelled";
  if (state.uncertain) return "uncertain";
  if (state.admitted) return "running";
  return "queued";
}

function frozenSummary(summary: InvocationSummary): InvocationSummary {
  return Object.freeze({
    ...summary,
    toolCalls: Object.freeze(
      summary.toolCalls.map((toolCall) => Object.freeze({ ...toolCall })),
    ),
    ...(summary.usage === undefined
      ? {}
      : { usage: Object.freeze({ ...summary.usage }) }),
  });
}

function snapshotOf(state: InvocationState): HarnessInvocationSnapshot {
  const recorded = state.recorded.payload;
  return Object.freeze({
    invocationId: recorded.invocationId,
    executionId: recorded.executionId,
    attributes: recorded.attributes,
    ...(recorded.resourceRef ? { resourceRef: recorded.resourceRef } : {}),
    verb: recorded.verb,
    phase: phaseOf(state),
    freshContext: recorded.freshContext,
    harnessTargetId: recorded.harnessTargetId,
    ...(state.scheduled === undefined
      ? {}
      : {
          contextId: state.scheduled.payload.contextId,
        }),
    ...(state.result === undefined
      ? {}
      : { result: frozenSummary(state.result) }),
    ...(state.cancelled === undefined
      ? {}
      : { cancellation: Object.freeze({ ...state.cancelled.payload }) }),
    ...(state.failed === undefined
      ? {}
      : { failure: Object.freeze({ ...state.failed.payload }) }),
  });
}

function invocationBlocks(state: InvocationState): readonly PromptBlock[] {
  const recorded = state.recorded.payload;
  return [{ type: "text", text: recorded.prompt }];
}

function scheduledOf(
  state: InvocationState,
): ScheduledHarnessInvocation | undefined {
  if (state.result || state.cancelled || state.failed) return;
  const scheduled = state.scheduled?.payload;
  if (!scheduled) return;
  const recorded = state.recorded.payload;
  return Object.freeze({
    invocationId: scheduled.invocationId,
    pluginInstanceId: pluginInstanceIdOf(state),
    harnessTargetId: scheduled.harnessTargetId,
    contextId: scheduled.contextId,
    freshContext: recorded.freshContext,
    source: "plugin",
    messageId: scheduled.messageId,
    blocks: invocationBlocks(state),
  });
}

/** Event-backed owner for a HarnessInvocation created by one live Plugin verb. */
export class HarnessInvocations {
  private readonly states = new Map<string, InvocationState>();
  private readonly invocationIdByMessage = new Map<string, string>();
  private readonly invocationIdByAttempt = new Map<string, string>();
  private readonly waiters = new Map<
    string,
    Set<(snapshot: HarnessInvocationSnapshot) => void>
  >();
  private readonly unsubscribe: () => void;

  constructor(
    private readonly records: HarnessInvocationRecords,
    private readonly options: HarnessInvocationsOptions = {},
  ) {
    this.unsubscribe = records.subscribe((event) => this.apply(event, true));
  }

  record(draft: ReconcileHarnessInvocation): HarnessInvocationSnapshot {
    this.records.requireExecutionContext(draft.invocation.contextId);
    const invocationId = newId("hinv");
    const invocation = draft.invocation;
    this.records.appendEvent({
      kind: "_aide_harness_invocation_recorded",
      source: {
        type: "plugin",
        pluginInstanceId: draft.scope.pluginInstanceId,
      },
      payload: {
        invocationId,
        executionId: draft.scope.executionId,
        attributes: draft.scope.attributes, resourceRef: draft.scope.resourceRef,
        verb: invocation.verb,
        title: invocation.title,
        prompt: invocation.prompt,
        contextId: invocation.contextId,
        freshContext: invocation.freshContext,
        harnessTargetId: invocation.harnessTargetId,
      },
    });
    const state = this.states.get(invocationId);
    if (!state) {
      throw new Error(`HarnessInvocation was not recorded: ${invocationId}`);
    }
    this.ensureScheduled(state);
    return snapshotOf(state);
  }

  scheduled(invocationId: string): ScheduledHarnessInvocation | undefined {
    const state = this.states.get(invocationId);
    return state ? scheduledOf(state) : undefined;
  }

  wait(invocationId: string): Promise<HarnessInvocationSnapshot> {
    const state = this.states.get(invocationId);
    if (!state) {
      return Promise.reject(
        new Error(`HarnessInvocation does not exist: ${invocationId}`),
      );
    }
    const snapshot = snapshotOf(state);
    if (
      snapshot.phase === "completed" ||
      snapshot.phase === "cancelled" ||
      snapshot.phase === "failed"
    ) {
      return Promise.resolve(snapshot);
    }
    return new Promise((resolve) => {
      const waiters = this.waiters.get(invocationId) ?? new Set();
      waiters.add(resolve);
      this.waiters.set(invocationId, waiters);
    });
  }

  list(): readonly HarnessInvocationSnapshot[] {
    return Object.freeze(
      [...this.states.values()]
        .sort((left, right) => left.recorded.seq - right.recorded.seq)
        .map(snapshotOf),
    );
  }

  latestCancellable(identifier?: string): HarnessInvocationSnapshot | undefined {
    const states = [...this.states.values()]
      .filter((state) => {
        const phase = phaseOf(state);
        return phase !== "completed" && phase !== "cancelled" &&
          phase !== "failed" &&
          (identifier === undefined ||
            state.recorded.payload.invocationId === identifier);
      })
      .sort((left, right) => right.recorded.seq - left.recorded.seq);
    return states[0] ? snapshotOf(states[0]) : undefined;
  }

  isAdmitted(invocationId: string): boolean {
    return this.states.get(invocationId)?.admitted ?? false;
  }

  cancel(
    invocationId: string,
    reason: "user" | "timeout" | "recovery",
    detail?: string,
  ): boolean {
    const state = this.states.get(invocationId);
    if (!state || state.result || state.cancelled || state.failed) return false;
    this.records.appendEvent({
      kind: "_aide_harness_invocation_cancelled",
      source: reason === "user" ? { type: "user" } : { type: "aide" },
      parentEventId: state.scheduled?.eventId ?? state.recorded.eventId,
      payload: {
        invocationId,
        reason,
        ...(detail === undefined ? {} : { detail }),
      },
    });
    return true;
  }

  fail(
    invocationId: string,
    reason: "dispatch" | "recovery",
    detail: string,
  ): boolean {
    const state = this.states.get(invocationId);
    if (!state || state.result || state.cancelled || state.failed) return false;
    this.records.appendEvent({
      kind: "_aide_harness_invocation_failed",
      source: { type: "aide" },
      parentEventId: state.scheduled?.eventId ?? state.recorded.eventId,
      payload: { invocationId, reason, detail },
    });
    return true;
  }

  failExecution(executionId: string, detail: string): string[] {
    const failed: string[] = [];
    for (const state of this.states.values()) {
      if (state.recorded.payload.executionId !== executionId) continue;
      const invocationId = state.recorded.payload.invocationId;
      if (this.fail(invocationId, "recovery", detail)) failed.push(invocationId);
    }
    return failed;
  }

  private readonly recent: string[] = [];
  release(id: string): void {
    this.recent.push(id);
    while (this.recent.length > RECENT_INVOCATIONS) {
      const old = this.recent.shift()!;
      this.states.delete(old);
      for (const index of [this.invocationIdByMessage, this.invocationIdByAttempt]) {
        for (const [key, value] of index) if (value === old) index.delete(key);
      }
    }
  }

  close(): void {
    this.unsubscribe();
  }

  private ensureScheduled(
    state: InvocationState,
  ): ScheduledHarnessInvocation | undefined {
    if (state.scheduled) return scheduledOf(state);
    if (state.cancelled || state.failed || state.result) return;
    const recorded = state.recorded.payload;
    invocationBlocks(state);
    this.records.requireExecutionContext(recorded.contextId);
    const scheduled: HarnessInvocationScheduled = {
      invocationId: recorded.invocationId,
      messageId: newId("m"),
      harnessTargetId: recorded.harnessTargetId,
      contextId: recorded.contextId,
    };
    this.records.appendEvent({
      kind: "_aide_harness_invocation_scheduled",
      source: { type: "aide" },
      parentEventId: state.recorded.eventId,
      payload: scheduled,
    });
    return scheduledOf(this.states.get(scheduled.invocationId) as InvocationState);
  }

  private apply(event: AnyEventEnvelope, notify: boolean): void {
    let changed: InvocationState | undefined;
    switch (event.kind) {
      case "_aide_harness_invocation_recorded": {
        if (this.states.has(event.payload.invocationId)) return;
        this.states.set(event.payload.invocationId, {
          recorded: event,
          admitted: false,
          uncertain: false,
        });
        return;
      }
      case "_aide_harness_invocation_scheduled": {
        const state = this.states.get(event.payload.invocationId);
        if (!state || state.scheduled) return;
        state.scheduled = event;
        this.invocationIdByMessage.set(
          event.payload.messageId,
          event.payload.invocationId,
        );
        changed = state;
        break;
      }
      case "user_message": {
        const id = this.invocationIdByMessage.get(event.payload.messageId);
        const state = id ? this.states.get(id) : undefined;
        if (!state || state.admitted) return;
        state.admitted = true;
        changed = state;
        break;
      }
      case "_aide_delivery_attempt_update": {
        const update = event.payload;
        let id = this.invocationIdByAttempt.get(update.attemptId);
        if (update.phase === "prepared") {
          id = this.invocationIdByMessage.get(update.inputId);
          if (id) this.invocationIdByAttempt.set(update.attemptId, id);
        }
        const state = id ? this.states.get(id) : undefined;
        if (!state) return;
        const uncertain = update.phase === "uncertain";
        if (state.uncertain === uncertain) return;
        state.uncertain = uncertain;
        changed = state;
        break;
      }
      case "_aide_invocation_summary": {
        const state = this.states.get(event.payload.invocationId);
        if (!state || state.result || state.cancelled || state.failed) return;
        state.result = event.payload;
        state.uncertain = false;
        changed = state;
        break;
      }
      case "_aide_harness_invocation_cancelled": {
        const state = this.states.get(event.payload.invocationId);
        if (!state || state.cancelled || state.failed || state.result) return;
        state.cancelled = event;
        changed = state;
        break;
      }
      case "_aide_harness_invocation_failed": {
        const state = this.states.get(event.payload.invocationId);
        if (!state || state.failed || state.cancelled || state.result) return;
        state.failed = event;
        changed = state;
        break;
      }
      default:
        return;
    }
    if (!changed) return;
    const snapshot = snapshotOf(changed);
    if (
      snapshot.phase === "completed" ||
      snapshot.phase === "cancelled" ||
      snapshot.phase === "failed"
    ) {
      const waiters = this.waiters.get(snapshot.invocationId);
      this.waiters.delete(snapshot.invocationId);
      for (const resolve of waiters ?? []) resolve(snapshot);
    }
    if (notify) this.options.onChanged?.(snapshot);
  }
}
