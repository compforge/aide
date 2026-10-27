import { connectorData } from "./data.ts";
import type { ConnectorAccess, ConnectorCallOptions, ConnectorApi, ConnectorDescription, ConnectorRef, ConnectorRequest } from "./contract.ts";

/** The same typed client is used by Host callers, Plugin callbacks and execution-scoped verbs. */
export function createConnectorAccess(invoke: <T>(request: ConnectorRequest) => Promise<T>): ConnectorAccess {
  const call = async (connector: ConnectorRef, method: string, supplied: readonly unknown[], options: ConnectorCallOptions = {}) => {
    const args = [...supplied];
    while (args.length && args.at(-1) === undefined) args.pop();
    return invoke({ operation: "connector.call", connector: { kind: connector.kind, version: connector.version, name: connector.name, revision: connector.revision },
      method, args: connectorData(args), ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) });
  };
  return Object.freeze({
    list: (kind?: string, version?: string) => invoke<readonly ConnectorDescription[]>({ operation: "connector.list",
      ...(kind !== undefined ? { kind } : {}), ...(version !== undefined ? { version } : {}) }),
    call,
    get<A extends ConnectorApi<A>>(connector: ConnectorDescription): A {
      const reference = Object.freeze({ kind: connector.kind, version: connector.version, name: connector.name, revision: connector.revision });
      return Object.freeze(Object.fromEntries(connector.methods.map(method => [method, (...args: unknown[]) => call(reference, method, args)]))) as A;
    },
  });
}
