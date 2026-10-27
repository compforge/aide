import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { createConnectorAccess, defineConnectorKind, connectorData, ConnectorTimeoutError, type ConnectorApi, type ConnectorAccess, type ConnectorCallOptions,
  type ConnectorRequest, type ConnectorDescription, type ConnectorImplementation, type ConnectorKind, type ConnectorRef } from "@compforge/aide-connector";

export interface ConnectorInvocationOptions extends ConnectorCallOptions { readonly signal?: AbortSignal }
export interface ConnectorLimits { readonly maxConcurrentCalls?: number; readonly maxQueuedCalls?: number }
interface Binding {
  description: ConnectorDescription;
  implementation: ConnectorImplementation<any>;
  kind: ConnectorKind;
  abort: AbortController;
  active: number;
  queue: Array<{ start(): void; cancel(error: Error): void }>;
  limits: { maxConcurrentCalls: number; maxQueuedCalls: number };
}
const keyOf = (ref: Pick<ConnectorRef, "kind" | "name">) => JSON.stringify([ref.kind, ref.name]);
const cancelled = (signal: AbortSignal) => signal.reason instanceof Error ? signal.reason : new Error("Connector call cancelled");

/**
 * @spec Every caller resolves the same (kind,name) binding. Stale revisions, unknown methods and conflicting contracts fail explicitly.
 * @spec Descriptions expose only declared public metadata. Queueing and active calls share one Connector capacity budget.
 * @why Kinds are extension-owned contracts; registering a new kind never requires another core dispatch branch.
 * @link docs/connector/extensions.md
 * @case tests/connector-registry.test.ts
 */
export class ConnectorRegistry implements ConnectorAccess {
  private readonly bindings = new Map<string, Binding>();
  private readonly contracts = new Map<string, string>();
  private closed = false;
  private closing?: Promise<void>;
  private readonly callOptions = new AsyncLocalStorage<ConnectorInvocationOptions>();
  private readonly client = createConnectorAccess(async <T>(request: ConnectorRequest): Promise<T> => {
    if (request.operation === "connector.list") return this.descriptions(request.kind, request.version) as T;
    return await this.call(request.connector, request.method, request.args, { timeoutMs: request.timeoutMs }) as T;
  });
  constructor(private readonly log?: (message: string, attributes: Record<string, unknown>) => void) {}
  withCallOptions<T>(options: ConnectorInvocationOptions, operation: () => Promise<T>): Promise<T> {
    return this.callOptions.run(options, operation);
  }
  private report(message: string, attributes: Record<string, unknown>) {
    try { this.log?.(message, attributes); } catch { /* Diagnostics do not own access lifecycle. */ }
  }

  register<A extends ConnectorApi<A>>(kind: ConnectorKind<A>, name: string, implementation: ConnectorImplementation<A>,
    options: ConnectorLimits & { revision?: string; signal?: AbortSignal } = {}): ConnectorDescription {
    if (this.closed) throw new Error("Connector registry is closed");
    const contract = defineConnectorKind(kind);
    if (!name.trim()) throw new Error("Connector name must not be empty");
    const key = keyOf({ kind: kind.kind, name });
    if (this.bindings.has(key)) throw new Error(`Connector already registered: ${kind.kind}/${name}`);
    const signature = JSON.stringify([...contract.methods].sort());
    const contractKey = JSON.stringify([kind.kind, kind.version]);
    if (this.contracts.has(contractKey) && this.contracts.get(contractKey) !== signature) throw new Error(`Conflicting Connector kind contract: ${kind.kind}@${kind.version}`);
    for (const method of contract.methods) if (typeof implementation.handlers[method] !== "function") throw new Error(`Connector ${kind.kind}/${name} is missing method ${method}`);
    const maxConcurrentCalls = options.maxConcurrentCalls ?? 4, maxQueuedCalls = options.maxQueuedCalls ?? 64;
    if (!Number.isSafeInteger(maxConcurrentCalls) || maxConcurrentCalls < 1 || !Number.isSafeInteger(maxQueuedCalls) || maxQueuedCalls < 0) throw new Error(`Invalid Connector capacity: ${kind.kind}/${name}`);
    const metadata = connectorData(implementation.metadata ?? {});
    const description: ConnectorDescription = Object.freeze({ kind: kind.kind, name, revision: options.revision ?? randomUUID(),
      version: kind.version, methods: Object.freeze([...contract.methods]), metadata: structuredClone(metadata) });
    const abort = new AbortController();
    if (options.signal) {
      if (options.signal.aborted) throw cancelled(options.signal);
      options.signal.addEventListener("abort", () => abort.abort(options.signal!.reason), { once: true });
    }
    this.contracts.set(contractKey, signature);
    this.bindings.set(key, { description, implementation, kind: contract, abort, active: 0, queue: [], limits: { maxConcurrentCalls, maxQueuedCalls } });
    this.report("Connector registered", { kind: kind.kind, name, version: kind.version });
    return structuredClone(description);
  }
  descriptions(kind?: string, version?: number): readonly ConnectorDescription[] {
    if (this.closed) throw new Error("Connector registry is closed");
    return [...this.bindings.values()].filter(b => !b.abort.signal.aborted && (!kind || b.description.kind === kind) && (version === undefined || b.description.version === version))
      .map(b => structuredClone(b.description));
  }
  async list<A extends ConnectorApi<A>>(kind?: ConnectorKind<A>): Promise<readonly ConnectorDescription[]> {
    return this.descriptions(kind?.kind, kind?.version);
  }
  get<A extends ConnectorApi<A>>(kind: ConnectorKind<A>, connector: ConnectorDescription): A { return this.client.get(kind, connector); }

  async call(ref: ConnectorRef, method: string, supplied: readonly unknown[], options: ConnectorInvocationOptions = {}): Promise<unknown> {
    const binding = this.bindings.get(keyOf(ref));
    if (this.closed || !binding || binding.abort.signal.aborted) throw new Error(`Connector is unavailable: ${ref.kind}/${ref.name}`);
    if (binding.description.revision !== ref.revision || binding.description.version !== ref.version) throw new Error(`Connector reference is stale: ${ref.kind}/${ref.name}`);
    if (!binding.description.methods.includes(method)) throw new Error(`Connector method is not registered: ${ref.kind}/${ref.name}.${method}`);
    let args = [...supplied]; while (args.length && args.at(-1) === undefined) args.pop();
    args = connectorData(args);
    const validation = binding.kind.validation?.[method];
    if (validation) args = validation.args.parse(args);
    const inherited = this.callOptions.getStore();
    const timeoutMs = Math.min(options.timeoutMs ?? inherited?.timeoutMs ?? 90_000, inherited?.timeoutMs ?? Infinity);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error("Connector timeoutMs must be a positive timer-safe integer");
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(new ConnectorTimeoutError(`Connector timed out: ${ref.kind}/${ref.name}.${method}`)), timeoutMs);
    const signal = AbortSignal.any([binding.abort.signal, deadline.signal, ...(options.signal ? [options.signal] : []), ...(inherited?.signal ? [inherited.signal] : [])]);
    try {
      await this.acquire(binding, signal);
      if (signal.aborted) { this.release(binding); throw cancelled(signal); }
      const startedAt = Date.now();
      const operation = Promise.resolve().then(() => {
        if (signal.aborted) throw cancelled(signal);
        return binding.implementation.handlers[method]!({ signal }, ...args);
      }).then(value => {
        return connectorData(validation ? validation.result.parse(value) : value);
      }).finally(() => this.release(binding));
      let onAbort: () => void = () => {};
      try {
        const value = await Promise.race([operation, new Promise<never>((_, reject) => {
          onAbort = () => reject(cancelled(signal));
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        })]);
        this.report("Connector call completed", { kind: ref.kind, name: ref.name, method, elapsedMs: Date.now() - startedAt });
        return value;
      } catch (error) {
        this.report("Connector call failed", { kind: ref.kind, name: ref.name, method, elapsedMs: Date.now() - startedAt, cancelled: signal.aborted });
        throw error;
      } finally { signal.removeEventListener("abort", onAbort); }
    } finally { clearTimeout(timer); }
  }

  private async acquire(binding: Binding, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw cancelled(signal);
    if (binding.active < binding.limits.maxConcurrentCalls) { binding.active++; return; }
    if (binding.queue.length >= binding.limits.maxQueuedCalls) throw new Error(`Connector queue is full: ${binding.description.kind}/${binding.description.name}`);
    await new Promise<void>((resolve, reject) => {
      const remove = () => signal.removeEventListener("abort", onAbort);
      const entry = { start: () => { remove(); binding.active++; resolve(); }, cancel: (error: Error) => { remove(); reject(error); } };
      const onAbort = () => { binding.queue = binding.queue.filter(item => item !== entry); entry.cancel(cancelled(signal)); };
      binding.queue.push(entry); signal.addEventListener("abort", onAbort, { once: true });
    });
  }
  private release(binding: Binding) { binding.active--; binding.queue.shift()?.start(); }
  async unregister(ref: ConnectorRef): Promise<void> {
    const binding = this.bindings.get(keyOf(ref));
    if (!binding || binding.description.revision !== ref.revision) throw new Error(`Connector reference is stale: ${ref.kind}/${ref.name}`);
    this.bindings.delete(keyOf(ref)); binding.abort.abort(new Error("Connector closed"));
    try { await binding.implementation.close?.(); }
    finally { this.report("Connector closed", { kind: ref.kind, name: ref.name }); }
  }
  close(): Promise<void> { return this.closing ??= this.closeAll(); }
  private async closeAll(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const binding of [...this.bindings.values()].reverse()) {
      try { await this.unregister(binding.description); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Connector shutdown failed");
  }
}
