import type { ConnectorClient } from "@compforge/aide-plugin";
import type { ConnectorRequest } from "./protocol/connectors.ts";

/** Typed facade over the existing Host/Runner request transport. */
export function createConnectorClient(invoke: <T>(request: ConnectorRequest) => Promise<T>): ConnectorClient {
  return Object.freeze({
    describe: () => invoke({ operation: "describe" }),
    environments: Object.freeze({
      list: () => invoke({ operation: "environments.list" }),
      workloads: (name, namespace) => invoke({ operation: "environments.workloads", name, namespace }),
      get: (name: string) => invoke({ operation: "environments.get", name }),
    } satisfies ConnectorClient["environments"]),
    requirements: Object.freeze({
      list: (source, query) => invoke({ operation: "requirements.list", source, ...(query ? { query } : {}) }),
      get: (identity) => invoke({ operation: "requirements.get", identity }),
    } satisfies ConnectorClient["requirements"]),
    forges: Object.freeze({
      list: (forge, path, query) => invoke({ operation: "forges.list", forge, path, query }),
      get: (identity) => invoke({ operation: "forges.get", identity }),
      comments: (identity) => invoke({ operation: "forges.comments", identity }),
    } satisfies ConnectorClient["forges"]),
  } satisfies ConnectorClient);
}

export function dispatchConnector(client: ConnectorClient, request: ConnectorRequest): Promise<unknown> {
  switch (request.operation) {
    case "describe": return client.describe();
    case "environments.list": return client.environments.list();
    case "environments.workloads": return client.environments.workloads(request.name, request.namespace);
    case "environments.get": return client.environments.get(request.name);
    case "requirements.list": return client.requirements.list(request.source, request.query);
    case "requirements.get": return client.requirements.get(request.identity);
    case "forges.list": return client.forges.list(request.forge, request.path, request.query);
    case "forges.get": return client.forges.get(request.identity);
    case "forges.comments": return client.forges.comments(request.identity);
  }
}

/** Hosts without configured connectors still expose the same discoverable capability. */
export const emptyConnectors = createConnectorClient(async <T>(request: ConnectorRequest): Promise<T> => {
  if (request.operation === "describe") return { environments: [], requirements: [], forges: [] } as T;
  if (request.operation === "environments.list") return [] as T;
  throw new Error("Connector is not configured");
});
