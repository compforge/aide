import { sameAddress } from "../../../src/address.ts";
import type { Address } from "@compforge/aide-plugin";
import type { Logger } from "pino";
import type { OutputStore } from "./store.ts";
import type { OutputStatus } from "./model.ts";

export interface OutputTransport {
  replay: "idempotent" | "once";
  send(message: { id: string; target: Address; text: string }): Promise<OutputStatus["receipt"]>;
}
export type OutputTransportResolver = (target: Address) => Promise<OutputTransport | undefined> | OutputTransport | undefined;

/**
 * @spec One Output owns checking, actual delivery and retries. Transport adapters never enumerate Outputs or schedule business work.
 * @spec Controller errors use per-resource runtime backoff. An interrupted non-idempotent effect remains uncertain.
 * @link docs/personal/disclosure.md
 */
export class OutputDelivery {
  private readonly running = new Map<string, Promise<void>>();
  constructor(private readonly store: OutputStore, private readonly transport: OutputTransportResolver, private readonly log: Logger) {}
  reconcile(id: string): Promise<void> {
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
  private async run(id: string) {
    let output = this.store.get(id);
    if (!output || output.metadata.deletionTimestamp || !["pending", "sending"].includes(output.status.phase)) return;
    if (output.status.phase === "sending" && output.status.delivery?.replay !== "idempotent") {
      this.store.uncertain(id, "Delivery was interrupted; verify external receipt before retrying"); return;
    }
    output = await this.store.prepare(id);
    if (!["pending", "sending"].includes(output.status.phase)) return;
    const target = output.status.delivery!.target;
    const transport = await this.transport(target);
    if (!transport) throw new Error("No configured transport for Output delivery");
    // Transport preparation may await provider metadata. Recheck permissions immediately before starting an effect.
    output = await this.store.prepare(id);
    if (!["pending", "sending"].includes(output.status.phase)) return;
    if (!sameAddress(output.status.delivery!.target, target)) throw new Error("Actual Output destination changed; reconcile again");
    if (output.status.attempts && output.status.delivery!.replay !== transport.replay) {
      this.store.uncertain(id, "Transport replay contract changed after a send attempt"); return;
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
        this.log.warn({ outputId: id }, "Output delivery uncertain"); return;
      }
      this.store.retry(id, "Transport send failed; retry scheduled by controller");
      throw new Error("Output transport failed");
    }
  }
}
