import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ENVELOPE_VERSION } from "../event/index.ts";
import { newId } from "../event/ids.ts";
import { EventLedger } from "../event/ledger.ts";
import type { AnyEventEnvelope, EventEnvelope, EventPayloadMap } from "../event/index.ts";
import type { ExecutionScope } from "../../protocol/verbs.ts";
import { acquireWriterLock, releaseWriterLock } from "../store/lease.ts";

type Started = EventEnvelope<"connector.started">;
type Outcome = EventPayloadMap["connector.settled"]["outcome"];
const writers = new Set<string>();

/**
 * @spec Persist dispatch before an external call. Interrupted outcomes are recorded, never automatically replayed.
 * @why Connector-only plugins must not open Harness storage to preserve this guarantee.
 * @link docs/kernel.md
 */
export class ConnectorCalls {
  private readonly pending = new Map<string, Started>();
  private ledger?: EventLedger;
  private nextSeq = 1;
  private ownsLock = false;
  private closed = false;
  constructor(private readonly home: string) {}

  private open(): void {
    if (this.closed) throw new Error("Connector calls are closed");
    if (this.ledger) return;
    const dir = join(this.home, "connectors");
    if (writers.has(dir)) throw new Error(`Connector storage is already active: ${dir}`);
    mkdirSync(dir, { recursive: true });
    if (!acquireWriterLock(join(dir, "lock"))) throw new Error(`Connector storage is already active: ${dir}`);
    writers.add(dir);
    this.ownsLock = true;
    try {
      const path = join(dir, "calls.jsonl");
      const ledger = new EventLedger({ path });
      const records = ledger.read();
      for (const event of records) this.apply(event);
      this.nextSeq = (records.at(-1)?.seq ?? 0) + 1;
      this.ledger = ledger;
    } catch (error) {
      writers.delete(dir); releaseWriterLock(join(dir, "lock")); this.ownsLock = false;
      throw error;
    }
  }
  private apply(event: AnyEventEnvelope): void {
    if (event.kind === "connector.started") this.pending.set(event.payload.callId, event);
    if (event.kind === "connector.settled") this.pending.delete(event.payload.callId);
  }
  start(scope: ExecutionScope, request: EventPayloadMap["connector.started"]["request"]): string {
    this.open();
    const callId = newId("cc");
    if (request.operation === "connector.call") request = { ...request, args: [] };
    const event: Started = { v: ENVELOPE_VERSION, eventId: newId("ev"), ts: new Date().toISOString(), seq: this.nextSeq,
      scope: { type: "application" }, source: { type: "plugin", pluginInstanceId: scope.pluginInstanceId },
      kind: "connector.started", payload: { callId, executionId: scope.executionId, request,
        resourceRef: scope.resourceRef, attributes: scope.attributes } };
    this.ledger?.record(event);
    this.nextSeq++;
    this.pending.set(callId, event);
    return callId;
  }
  settle(callId: string, outcome: Outcome, error?: string): void {
    const started = this.pending.get(callId);
    if (!started) return;
    const event: EventEnvelope<"connector.settled"> = { v: ENVELOPE_VERSION, eventId: newId("ev"), ts: new Date().toISOString(), seq: this.nextSeq,
      scope: { type: "application" }, source: started.source, kind: "connector.settled",
      payload: { callId, outcome, ...(error ? { error } : {}) } };
    this.ledger?.record(event);
    this.nextSeq++;
    this.pending.delete(callId);
  }
  failInstance(pluginInstanceId: string, error: string): void {
    for (const [id, event] of this.pending) {
      if (event.source.type === "plugin" && event.source.pluginInstanceId === pluginInstanceId) this.settle(id, "interrupted", error);
    }
  }
  failAll(error: string): void { for (const id of this.pending.keys()) this.settle(id, "interrupted", error); }
  failOrphans(): void {
    if (existsSync(join(this.home, "connectors", "calls.jsonl"))) this.open();
    this.failAll("Core restarted; external outcome is unknown");
  }
  close(): void {
    this.closed = true;
    if (this.ownsLock && this.home) {
      const dir = join(this.home, "connectors");
      writers.delete(dir); releaseWriterLock(join(dir, "lock")); this.ownsLock = false;
    }
  }
}
