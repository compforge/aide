export type ConnectorApi<A> = { [K in keyof A]: (...args: any[]) => Promise<any> };
export interface ConnectorSchema<T> { parse(value: unknown): T }

export interface ConnectorRef {
  readonly kind: string;
  /** Operation contract version; independent of the providing package release. */
  readonly version: string;
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
  /** Reads the Host's immutable environment snapshot; reads also bind the Connector revision. */
  env(name: string): string | undefined;
}
export interface ConnectorImplementation<A extends ConnectorApi<A>> {
  readonly handlers: ConnectorHandlers<A>;
  /** Trusted Host delivery only; never discoverable or callable through Plugin IPC. */
  readonly hostHandlers?: Readonly<Record<string, (context: ConnectorCallContext, ...args: any[]) => Promise<unknown>>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  close?(): Promise<void> | void;
}
export interface ConnectorDefinition<C = any, A extends ConnectorApi<A> = any> {
  readonly kind: string;
  /** Operation contract version; independent of the providing package release. */
  readonly version: string;
  readonly config: ConnectorSchema<C>;
  create(context: ConnectorContext, config: C): Promise<ConnectorImplementation<A>> | ConnectorImplementation<A>;
}
/** Host installation entry: bind configured names to imported factories, independently of declarations. */
export interface ConnectorPackage {
  readonly id: string;
  readonly version: string;
  readonly connectors: Readonly<Record<string, ConnectorDefinition>>;
}
export interface ConnectorCallOptions {
  readonly timeoutMs?: number;
}
export interface ConnectorAccess {
  /** Both filters use exact string equality; omission discovers all matching Connectors. */
  list(kind?: string, version?: string): Promise<readonly ConnectorDescription[]>;
  get<A extends ConnectorApi<A>>(connector: ConnectorDescription): A;
  /** Transport-level invocation; callers normally use get() for typed methods. */
  call(connector: ConnectorRef, method: string, args: readonly unknown[], options?: ConnectorCallOptions): Promise<unknown>;
}
export type ConnectorRequest =
  | { readonly operation: "connector.list"; readonly kind?: string; readonly version?: string }
  | { readonly operation: "connector.call"; readonly connector: ConnectorRef; readonly method: string; readonly args: readonly unknown[]; readonly timeoutMs?: number };

export class ConnectorTimeoutError extends Error {
  constructor(message: string) { super(message); this.name = "ConnectorTimeoutError"; }
}
