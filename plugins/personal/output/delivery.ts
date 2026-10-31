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
      const current = this.store.get(id);
      if (current && current.status.phase === "pending" && !current.status.lastError) this.store.update(id, s => ({ ...s, lastError: "Output preparation failed; retry scheduled by controller" }));
      this.log.warn({ outputId: id }, "Output reconcile failed; independent retry required");
      throw error;
    }).finally(() => this.running.delete(id));
    this.running.set(id, run); return run;
  }
  private async run(id: string): Promise<OutputReconcileResult> {
    let output = this.store.get(id);
    if (!output || output.metadata.deletionTimestamp || !["pending", "sending"].includes(output.status.phase)) return {};
    if (output.status.phase === "sending" && output.status.delivery?.replay !== "idempotent") {
      this.store.uncertain(id, "Delivery was interrupted; verify external receipt before retrying"); return {};
    }
    output = await this.store.prepare(id);
    if (!["pending", "sending"].includes(output.status.phase)) return {};
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
      await this.send(id, output, transport);
      return {};
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
    this.store.begin(id);
    try {
      const receipt = await transport.send({ id, target, text: output.status.delivery!.text });
      this.store.delivered(id, receipt);
      this.log.info({ outputId: id, target }, "Output delivered");
    } catch {
      if (transport.replay === "once") {
        this.store.uncertain(id, "Delivery result is unknown; verify external receipt before retrying");
        this.log.warn({ outputId: id }, "Output delivery uncertain"); return {};
      }
      this.store.retry(id, "Transport send failed; retry scheduled by controller");
      throw new Error("Output transport failed");
    }
  }
}
