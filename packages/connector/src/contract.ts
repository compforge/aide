export type ConnectorApi<A> = { [K in keyof A]: (...args: any[]) => Promise<any> };
export interface ConnectorSchema<T> { parse(value: unknown): T }

/** A shared method contract. Implementations and credentials never enter this descriptor. */
export interface ConnectorKind<A extends ConnectorApi<A> = any> {
  readonly kind: string;
  readonly version: number;
  readonly methods: readonly (keyof A & string)[];
  readonly validation?: { readonly [K in keyof A]?: {
    readonly args: ConnectorSchema<Parameters<A[K]>>;
    readonly result: ConnectorSchema<Awaited<ReturnType<A[K]>>>;
  } };
}
export interface ConnectorRef {
  readonly kind: string;
  readonly version: number;
  readonly name: string;
  /** Opaque access/configuration revision. A stale reference must fail instead of switching credentials. */
  readonly revision: string;
}
export interface ConnectorDescription extends ConnectorRef {
  readonly methods: readonly string[];
  /** Explicitly public facts only; never the provider's configuration or credentials. */
  readonly metadata: Readonly<Record<string, unknown>>;
}
export interface ConnectorCallContext {
  readonly signal: AbortSignal;
}
export type ConnectorHandlers<A extends ConnectorApi<A>> = {
  readonly [K in keyof A]: (context: ConnectorCallContext, ...args: Parameters<A[K]>) => ReturnType<A[K]>;
};
export interface ConnectorContext {
  readonly name: string;
  readonly signal: AbortSignal;
  /** Reads the Host's immutable environment snapshot; reads also bind the connection revision. */
  env(name: string): string | undefined;
}
export interface ConnectorImplementation<A extends ConnectorApi<A>> {
  readonly handlers: ConnectorHandlers<A>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  close?(): Promise<void> | void;
}
export interface ConnectorDefinition<C = any, A extends ConnectorApi<A> = any> {
  readonly type: string;
  readonly kind: ConnectorKind<A>;
  readonly config: ConnectorSchema<C>;
  create(context: ConnectorContext, config: C): Promise<ConnectorImplementation<A>> | ConnectorImplementation<A>;
}
/** One trusted Host-loaded distribution may supply any number of Connector kinds/implementations. */
export interface ConnectorPackage {
  readonly id: string;
  readonly version: string;
  readonly connectors: readonly ConnectorDefinition[];
}
export interface ConnectorCallOptions {
  readonly timeoutMs?: number;
}
export interface ConnectorAccess {
  list<A extends ConnectorApi<A>>(kind?: ConnectorKind<A>): Promise<readonly ConnectorDescription[]>;
  get<A extends ConnectorApi<A>>(kind: ConnectorKind<A>, connector: ConnectorDescription): A;
  /** Transport-level invocation; callers normally use get() for typed methods. */
  call(connector: ConnectorRef, method: string, args: readonly unknown[], options?: ConnectorCallOptions): Promise<unknown>;
}
export type ConnectorRequest =
  | { readonly operation: "connector.list"; readonly kind?: string; readonly version?: number }
  | { readonly operation: "connector.call"; readonly connector: ConnectorRef; readonly method: string; readonly args: readonly unknown[]; readonly timeoutMs?: number };

/** @spec Kind identity and method names are explicit, stable and serializable across Host/Runner boundaries. */
export function defineConnectorKind<A extends ConnectorApi<A>>(kind: ConnectorKind<A>): ConnectorKind<A> {
  if (!/^[a-zA-Z][a-zA-Z0-9_.:/-]*$/.test(kind.kind) || !Number.isSafeInteger(kind.version) || kind.version < 1) throw new Error("Invalid Connector kind identity/version");
  if (!kind.methods.length || new Set(kind.methods).size !== kind.methods.length || kind.methods.some(name =>
    !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name) || ["then", "constructor", "prototype", "__proto__"].includes(name))) throw new Error(`Invalid Connector methods: ${kind.kind}`);
  return Object.freeze({ ...kind, methods: Object.freeze([...kind.methods]) });
}

export class ConnectorTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "ConnectorTimeoutError"; }
}
