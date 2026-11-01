import { Addresses } from "../address/service.ts";
import { deliveryFailure, type DeliveryFailure } from "@compforge/aide-connector";
import { nextDeliveryAt } from "./frequency.ts";
import type { ResourceStorage } from "../../../src/host/resource/storage.ts";
import { sameAddress } from "../../../src/address.ts";
import type { Address } from "@compforge/aide-plugin";
import type { Logger } from "pino";
import type { OutputStore } from "./store.ts";
import type { Output, OutputReconcileResult, OutputStatus } from "./model.ts";

export interface OutputTransport {
  replay: "idempotent" | "once";
  send(message: { id: string; target: Address; text: string }): Promise<OutputStatus["receipt"]>;
}
export type OutputTransportResolver = (target: Address) => Promise<OutputTransport | undefined> | OutputTransport | undefined;

class OutputRetryError extends Error {}

const activeReceivers = new WeakMap<ResourceStorage, Set<string>>();

/**
 * @spec One Output owns checking, actual delivery and retries. Transport adapters never enumerate Outputs or schedule business work.
 * @spec Controller errors use per-resource runtime backoff. An interrupted non-idempotent effect remains uncertain.
 * @link docs/personal/disclosure.md
 * @spec Actual receivers share a single in-flight send per Host; waiting does not count as an attempt.
 * @link docs/personal/output.md#投递频控
 * @case tests/output-frequency.test.ts
 */
export class OutputDelivery {
  private readonly running = new Map<string, Promise<OutputReconcileResult>>();
  constructor(private readonly store: OutputStore, private readonly transport: OutputTransportResolver, private readonly log: Logger) {}
  reconcile(id: string): Promise<OutputReconcileResult> {
    const existing = this.running.get(id);
    if (existing) return existing;
    const run = this.run(id).catch(error => {
      if (error instanceof OutputRetryError) throw error;
      const current = this.store.get(id);
      // A sending state can already have an external effect; leave recovery to the replay contract.
      if (current?.status.phase === "pending") {
        return this.failure(id, deliveryFailure(error) ?? { kind: "retryable", message: "Output preparation failed; retry scheduled by controller" }, true);
      }
      throw new Error(current?.status.lastError ?? "Output reconcile failed");
    }).finally(() => this.running.delete(id));
    this.running.set(id, run); return run;
  }
  private async run(id: string): Promise<OutputReconcileResult> {
    let output = this.store.get(id);
    if (!output || output.metadata.deletionTimestamp || !["pending", "sending"].includes(output.status.phase)) return {};
    if (output.status.phase === "sending" && output.status.delivery?.replay !== "idempotent") {
      this.store.uncertain(id, "Delivery was interrupted; verify external receipt before retrying"); return {};
    }
    const wait = output.status.deliveryWait;
    // Provider deadlines survive early watches and Host restarts; Person policy waits are recomputed below.
    output = await this.store.prepare(id);
    if (!["pending", "sending"].includes(output.status.phase)) {
      this.log.info({ outputId: id, phase: output.status.phase }, "Output no longer requires delivery");
      return {};
    }
    if (wait?.reason === "provider" && Date.parse(wait.until) > Date.now()) return { requeueAfterMs: Math.max(1, Date.parse(wait.until) - Date.now()) };
    // Acquire every receiver together without waiting; no partial acquisition or unbounded Promise queue.
    // The shared Host retains this execution right through actual transport completion, including Runner restarts.
    const receivers = [...output.status.delivery!.receivers].map(p => p.uid).sort();
    let active = activeReceivers.get(this.store.storage);
    if (!active) { active = new Set(); activeReceivers.set(this.store.storage, active); }
    if (receivers.some(uid => active.has(uid))) return this.defer(id, Date.now() + 1000, "receiver-busy");
    for (const uid of receivers) active.add(uid);
    try {
      const next = nextDeliveryAt(this.store, output);
      if (next > Date.now()) return this.defer(id, next, "frequency");
      const target = output.status.delivery!.target;
      const transport = await this.transport(target);
      if (!transport) throw new Error("No configured transport for Output delivery");
      // Awaited preparation can change permission, audience or frequency policy. Recheck before sending.
      output = await this.store.prepare(id);
      if (!["pending", "sending"].includes(output.status.phase)) return {};
      if (!sameAddress(output.status.delivery!.target, target)) throw new Error("Actual Output destination changed; reconcile again");
      const currentReceivers = [...output.status.delivery!.receivers].map(p => p.uid).sort();
      if (JSON.stringify(currentReceivers) !== JSON.stringify(receivers)) return this.defer(id, Date.now() + 1, "receiver-busy");
      const due = nextDeliveryAt(this.store, output);
      if (due > Date.now()) return this.defer(id, due, "frequency");
      return await this.send(id, output, transport);
    } finally { for (const uid of receivers) active.delete(uid); }
  }

  private defer(id: string, at: number, reason: "frequency" | "receiver-busy"): OutputReconcileResult {
    const until = new Date(at).toISOString();
    this.store.update(id, s => ({ ...s, deliveryWait: { reason, until } }));
    this.log.debug({ outputId: id, reason, until }, "Output delivery deferred");
    return { requeueAfterMs: Math.max(1, at - Date.now()) };
  }

  private async send(id: string, output: Output, transport: OutputTransport) {
    const target = output.status.delivery!.target;
    if (output.status.attempts && output.status.delivery!.replay !== transport.replay) {
      this.store.uncertain(id, "Transport replay contract changed after a send attempt"); return {};
    }
    if (!output.status.attempts) this.store.update(id, s => ({ ...s, delivery: { ...s.delivery!, replay: transport.replay } }));
    if (new Addresses(this.store.storage.home).observe(target).spec.muted) throw new Error("Address was muted before transport dispatch");
    this.store.begin(id);
    try {
      const receipt = await transport.send({ id, target, text: output.status.delivery!.text });
      this.store.delivered(id, receipt);
      this.log.info({ outputId: id, target }, "Output delivered");
      return {};
    } catch (error) {
      return this.failure(id, deliveryFailure(error) ?? { kind: "unknown", message: "Output transport failed; delivery result is unknown" }, transport.replay === "idempotent");
    }
  }

  /** @spec Explicit rejection can retry even a non-idempotent write; uncertain effects require safe replay or receipt recovery.
   * @case tests/requirement-output.test.ts
   */
  private failure(id: string, failure: DeliveryFailure, safeReplay: boolean): OutputReconcileResult {
    const reason = `${failure.message}${failure.code ? ` [${failure.code}]` : ""}`.slice(0, 4000);
    this.log.warn({ outputId: id, kind: failure.kind, code: failure.code, retryAfterMs: failure.retryAfterMs, reason }, "Output delivery failed");
    if (failure.kind === "permanent") { this.store.failed(id, reason); return {}; }
    if (failure.kind === "unknown" && !safeReplay) { this.store.uncertain(id, reason); return {}; }
    const until = failure.retryAfterMs === undefined ? undefined : new Date(Date.now() + failure.retryAfterMs).toISOString();
    // Commit the rejection and provider deadline together before yielding the controller.
    this.store.retry(id, reason, until);
    if (until) return { requeueAfterMs: Math.max(1, Date.parse(until) - Date.now()) };
    throw new OutputRetryError(reason);
  }
}
