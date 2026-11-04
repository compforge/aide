import { aideErrorDetails } from "@compforge/aide-common";
import { outputPolicy, type OutputPolicy } from "./config.ts";
import { setTimeout as delay } from "node:timers/promises";
import type { StreamReader } from "@compforge/aide-plugin";
import { isMuteMail } from "../stream/notices.ts";
import { Addresses } from "../address/service.ts";
import { deliveryFailure, type DeliveryFailure } from "@compforge/aide-connector";
import { nextDeliveryAt } from "./frequency.ts";
import type { ResourceStorage } from "../../../src/host/resource/storage.ts";
import { sameAddress } from "../../../src/address.ts";
import type { Address } from "@compforge/aide-plugin";
import type { Logger } from "pino";
import type { OutputStore } from "./store.ts";
import { type Output, type OutputReconcileResult, type OutputStatus } from "./model.ts";

export type OutputMessage = { id: string; target: Address; stream: StreamReader; permitMuted?: boolean };
export interface OutputTransport {
  replay: "idempotent" | "once";
  streaming?: boolean;
  send(message: OutputMessage): Promise<OutputStatus["receipt"]>;
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
  private readonly stopping = new AbortController();
  private readonly running = new Map<string, Promise<OutputReconcileResult>>();
  constructor(private readonly store: OutputStore, private readonly transport: OutputTransportResolver, private readonly log: Logger, private readonly policy: OutputPolicy = outputPolicy()) {}
  async reconcile(id: string): Promise<OutputReconcileResult> {
    if (this.stopping.signal.aborted) return {};
    const existing = this.running.get(id);
    if (existing) return { requeueAfterMs: 1000 };
    const run = this.run(id).catch(error => {
      if (this.stopping.signal.aborted || !this.store.get(id) || this.store.get(id)?.metadata.deletionTimestamp) return {};
      if (error instanceof OutputRetryError) throw error;
      return this.preparationFailure(id, error);
    }).finally(() => this.running.delete(id));
    this.running.set(id, run);
    // The Host owns active subscriptions; Runner reconciliation remains short and can bind other Outputs.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([run, new Promise<OutputReconcileResult>(resolve => { timer = setTimeout(() => resolve({ requeueAfterMs: 1000 }), 25); })]); }
    finally { clearTimeout(timer); }
  }
  async close(): Promise<void> {
    this.stopping.abort(new Error("Output delivery is stopping"));
    await Promise.allSettled(this.running.values());
  }
  /** @spec Typed transient preparation failures have a bounded budget; successful dispatch preparation resets it without consuming extra send attempts. */
  private preparationFailure(id: string, error: unknown): OutputReconcileResult {
    const current = this.store.get(id);
    if (!current || !["pending", "sending"].includes(current.status.phase)) return {};
    const failure = deliveryFailure(error), details = aideErrorDetails(error);
    const reason = failure?.message ?? details?.message ?? "Output preparation failed; automatic delivery stopped";
    const code = details?.code ?? failure?.code ?? "output_preparation_failed";
    const biz_code = details?.biz_code ?? failure?.biz_code;
    const diagnostic = `${reason} [${code}]${biz_code ? ` [${biz_code}]` : ""}`;
    const attempts = (current.status.preparationAttempts ?? 0) + 1;
    this.store.update(id, s => ({ ...s, preparationAttempts: attempts }));
    if (details?.retryable && attempts < this.policy.maxAttempts) {
      this.log.warn({ outputId: id, code, biz_code, preparationAttempts: attempts, maxAttempts: this.policy.maxAttempts }, "Output preparation failed; retry scheduled");
      return this.scheduleRetry(id, diagnostic, failure?.retryAfterMs);
    }
    // A recovered sending state can already have an external effect even if this preparation did no write.
    if (current.status.phase === "sending" && current.status.delivery?.operation) this.store.uncertain(id, diagnostic); else this.store.failed(id, diagnostic);
    this.log.warn({ outputId: id, code, biz_code, attempts: current.status.attempts, phase: this.store.get(id)!.status.phase }, "Output preparation failed; automatic delivery stopped");
    return {};
  }
  private async run(id: string): Promise<OutputReconcileResult> {
    let output = this.store.get(id);
    if (!output || output.metadata.deletionTimestamp || !["pending", "sending"].includes(output.status.phase)) return {};
    if (output.status.phase === "sending" && output.status.delivery?.operation && output.status.delivery.operation.lastFailureKind !== "retryable" && output.status.delivery.replay !== "idempotent") {
      this.store.uncertain(id, "Delivery was interrupted; verify external receipt before retrying"); return {};
    }
    if ((output.status.delivery?.operation?.attempts ?? 0) >= this.policy.maxAttempts)
      return this.exhaustAttempts(id, output.status.lastError ?? "No operation budget remains", output.status.delivery?.operation?.lastFailureKind !== "retryable");
    const wait = output.status.deliveryWait;
    if (wait?.reason === "provider" && Date.parse(wait.until) > Date.now()) return { requeueAfterMs: Math.max(1, Date.parse(wait.until) - Date.now()) };
    // Provider deadlines survive early watches and Host restarts; Person policy waits are recomputed below.
    output = await this.store.prepare(id);
    if (!["pending", "sending"].includes(output.status.phase)) return {};
    while (!output.status.delivery || !output.status.disclosure) {
      const stream = this.store.streams.get(output.spec.stream).status;
      if (stream.phase !== "open") throw new Error("Output disclosure did not authorize a closed stream");
      await this.store.streams.wait(output.spec.stream, stream.lastSeq, this.stopping.signal);
      output = await this.store.prepare(id);
      if (output.metadata.deletionTimestamp || !["pending", "sending"].includes(output.status.phase)) return {};
    }
    if (!["pending", "sending"].includes(output.status.phase)) {
      this.log.info({ outputId: id, phase: output.status.phase }, "Output no longer requires delivery");
      return {};
    }
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
      if (!output.status.delivery) return { requeueAfterMs: 1000 };
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
    let dispatching = false;
    try {
      for (;;) {
        this.stopping.signal.throwIfAborted();
        output = await this.store.prepare(id);
        if (output.metadata.deletionTimestamp || !["pending", "sending"].includes(output.status.phase)) return {};
        if (!output.status.delivery) return { requeueAfterMs: 1000 };
        const delivery = output.status.delivery;
        const content = delivery.operation?.snapshot ?? this.store.streams.get(delivery.stream).status;
        const notice = isMuteMail(this.store, output);
        if (new Addresses(this.store.storage.home).read(delivery.address).spec.muted && !notice) throw new Error("Address was muted before transport dispatch");
        if (!delivery.operation && content.phase === "open" && (!transport.streaming || content.lastSeq === (delivery.confirmedSeq ?? 0))) {
          await this.store.streams.wait(delivery.stream, content.lastSeq, this.stopping.signal);
          continue;
        }
        // A saved destination/stream never changes within this subscription.
        if (!sameAddress(delivery.target, target)) throw new Error("Actual Output destination changed during streaming");
        if (!this.store.begin(id, this.policy.maxAttempts))
          return this.exhaustAttempts(id, "Stream delivery is incomplete", false);
        const operation = this.store.get(id)!.status.delivery!.operation!;
        const stream = this.store.streams.reader(delivery.stream, operation.snapshot);
        dispatching = true;
        const receipt = await transport.send({ id, target, stream, permitMuted: notice });
        dispatching = false;
        if (!this.store.get(id) || this.store.get(id)?.metadata.deletionTimestamp) return {};
        this.store.confirm(id, receipt);
        this.log.debug({ outputId: id, confirmedSeq: content.lastSeq, operationAttempts: operation.attempts, attempts: this.store.get(id)!.status.attempts }, "Output operation confirmed");
        if (content.phase !== "open") {
          this.log.info({ outputId: id, streamUid: delivery.stream.uid, confirmedSeq: content.lastSeq, phase: content.phase }, "Output stream delivery settled");
          return {};
        }
        await delay(750, undefined, { signal: this.stopping.signal });
      }
    } catch (error) {
      if (this.stopping.signal.aborted || !this.store.get(id) || this.store.get(id)?.metadata.deletionTimestamp) return {};
      if (!dispatching) return this.preparationFailure(id, error);
      const failure = deliveryFailure(error), details = aideErrorDetails(error);
      return this.failure(id, failure ?? { kind: "unknown", message: details?.message ?? "Output transport failed; delivery result is unknown",
        code: details?.code ?? "delivery_unknown", biz_code: details?.biz_code }, transport.replay === "idempotent",
        details?.retryable ?? (failure?.kind !== "permanent"));
    }
  }

  /** @spec Each persisted Stream snapshot gets its own bounded send budget across restarts; successful progress never exhausts later operations.
   * @spec Exhaustion only ends delivery; it never closes the Stream or cancels its producing execution. Unknown outcomes remain uncertain.
   * @link docs/personal/output.md
   * @case tests/output-retry.test.ts
   */
  private exhaustAttempts(id: string, reason: string, uncertain: boolean): OutputReconcileResult {
    const output = this.store.get(id)!;
    const error = `Output attempt limit reached (${this.policy.maxAttempts} attempts): ${reason}`;
    if (uncertain) this.store.uncertain(id, error); else this.store.failed(id, error);
    this.log.warn({ outputId: id, maxAttempts: this.policy.maxAttempts,
      attempts: output.status.attempts, operationAttempts: output.status.delivery?.operation?.attempts, phase: uncertain ? "uncertain" : "failed" }, "Output attempt limit reached");
    return {};
  }

  /** @spec Explicit rejection can retry even a non-idempotent write; uncertain effects require safe replay or receipt recovery.
   * @case tests/requirement-output.test.ts
   */
  private failure(id: string, failure: DeliveryFailure, safeReplay: boolean, retryable: boolean): OutputReconcileResult {
    const reason = `${failure.message}${failure.code ? ` [${failure.code}]` : ""}${failure.biz_code ? ` [${failure.biz_code}]` : ""}`.slice(0, 4000);
    this.store.update(id, s => ({ ...s, delivery: { ...s.delivery!, operation: { ...s.delivery!.operation!, lastFailureKind: failure.kind } } }));
    this.log.warn({ outputId: id, attempts: this.store.get(id)!.status.attempts, operationAttempts: this.store.get(id)!.status.delivery!.operation!.attempts, maxAttempts: this.policy.maxAttempts, kind: failure.kind, retryable, code: failure.code, biz_code: failure.biz_code, retryAfterMs: failure.retryAfterMs, reason }, "Output delivery failed");
    if (failure.kind === "permanent") { this.store.failed(id, reason); return {}; }
    if (failure.kind === "unknown" && (!retryable || !safeReplay)) { this.store.uncertain(id, reason); return {}; }
    if ((this.store.get(id)!.status.delivery?.operation?.attempts ?? 0) >= this.policy.maxAttempts)
      return this.exhaustAttempts(id, reason, failure.kind === "unknown");
    return this.scheduleRetry(id, reason, failure.retryAfterMs);
  }
  private scheduleRetry(id: string, reason: string, retryAfterMs?: number): OutputReconcileResult {
    const until = retryAfterMs === undefined ? undefined : new Date(Date.now() + retryAfterMs).toISOString();
    // Commit the rejection and provider deadline together before yielding the controller.
    this.store.retry(id, reason, until);
    if (until) return { requeueAfterMs: Math.max(1, Date.parse(until) - Date.now()) };
    throw new OutputRetryError(reason);
  }
}
