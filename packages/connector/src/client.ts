import { connectorData } from "./data.ts";
import type { ConnectorAccess, ConnectorCallOptions, ConnectorApi, ConnectorDescription, ConnectorKind, ConnectorRef, ConnectorRequest } from "./contract.ts";

/** The same typed client is used by Host callers, Plugin callbacks and execution-scoped verbs. */
export function createConnectorAccess(invoke: <T>(request: ConnectorRequest) => Promise<T>): ConnectorAccess {
  const call = async (connector: ConnectorRef, method: string, supplied: readonly unknown[], options: ConnectorCallOptions = {}) => {
    const args = [...supplied];
    while (args.length && args.at(-1) === undefined) args.pop();
    return invoke({ operation: "connector.call", connector: { kind: connector.kind, version: connector.version, name: connector.name, revision: connector.revision },
      method, args: connectorData(args), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
  };
  return Object.freeze({
    list: <A extends ConnectorApi<A>>(kind?: ConnectorKind<A>) => invoke<readonly ConnectorDescription[]>({ operation: "connector.list",
      ...(kind ? { kind: kind.kind, version: kind.version } : {}) }),
    call,
    get<A extends ConnectorApi<A>>(kind: ConnectorKind<A>, connector: ConnectorDescription): A {
      if (kind.kind !== connector.kind || kind.version !== connector.version || kind.methods.some(method => !connector.methods.includes(method))) throw new Error(`Connector contract mismatch: ${connector.kind}/${connector.name}`);
      const reference = Object.freeze({ kind: connector.kind, version: connector.version, name: connector.name, revision: connector.revision });
      return Object.freeze(Object.fromEntries(kind.methods.map(method => [method, (...args: unknown[]) => call(reference, method, args)]))) as A;
    },
  });
}
