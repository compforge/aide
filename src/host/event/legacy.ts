import { ENVELOPE_VERSION, type AnyEventEnvelope } from "./index.ts";

type StoredEvent = Record<string, unknown> & { kind: string; payload: Record<string, unknown> };
function storedEvent(value: unknown): StoredEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Execution event must be an object");
  const event = value as Record<string, unknown>;
  if (typeof event.kind !== "string" || !event.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    throw new Error("Execution event requires kind and object payload");
  }
  return event as StoredEvent;
}

/** @spec Translate legacy host coordinates only; raw provider data, sequence numbers and timestamps are immutable.
 * @why The old scheduled fact associates a Turn ID with its existing HarnessInvocation ID.
 * @link tests/execution-journal.test.ts
 */
export function readExecutionEvents(records: readonly unknown[]): AnyEventEnvelope[] {
  const events = records.map(storedEvent);
  const ids = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "_aide_harness_invocation_scheduled" && typeof event.payload.turnId === "string" && typeof event.payload.invocationId === "string") {
      ids.set(event.payload.turnId, event.payload.invocationId);
    }
  }
  const identity = (id: unknown) => typeof id === "string" ? ids.get(id) ?? id : undefined;
  return events.map(event => {
    const { turnId, laneId, ...envelope } = event;
    const invocationId = event.invocationId ?? identity(turnId);
    const contextId = event.contextId ?? laneId;
    let payload = event.payload;
    if (event.kind === "_aide_turn_summary" || event.kind === "_aide_queue_reordered" || event.kind === "harness_input.updated" || event.kind === "_aide_harness_invocation_scheduled") {
      const { turnId: previous, laneId: previousContext, ...current } = payload;
      payload = { ...current,
        ...(current.invocationId !== undefined || previous === undefined ? {} : { invocationId: identity(previous) }),
        ...(current.contextId !== undefined || previousContext === undefined ? {} : { contextId: previousContext }),
      };
    } else if (event.kind === "approval.cancelled" && payload.reason === "turn") {
      payload = { ...payload, reason: "invocation" };
    } else if (event.kind === "_aide_harness_invocation_recorded") {
      const { laneId: previousContext, newLane: _newLane, ...current } = payload;
      payload = { ...current, ...(current.contextId !== undefined || previousContext === undefined ? {} : { contextId: previousContext }) };
    }
    if (event.kind === "_aide_context_snapshot" && contextId) {
      const source = payload.source as { kind?: string } | undefined;
      if (source?.kind === "session_history") payload = { ...payload, source: {
        kind: "context_history", key: "history", owner: { type: "execution_context", contextId },
      } };
    }
    return { ...envelope, v: ENVELOPE_VERSION, scope: { type: "application" },
      kind: event.kind === "_aide_turn_summary" ? "_aide_invocation_summary" : event.kind,
      ...(invocationId === undefined ? {} : { invocationId }),
      ...(contextId === undefined ? {} : { contextId }), payload,
    } as unknown as AnyEventEnvelope;
  });
}
