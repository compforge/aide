import type { ConnectorClient } from "@compforge/aide-plugin";
import type { ConnectorRequest } from "./protocol/connectors.ts";

/** Typed facade over the existing Host/Runner request transport. */
export function createConnectorClient(invoke: <T>(request: ConnectorRequest) => Promise<T>): ConnectorClient {
  return Object.freeze({
    describe: () => invoke({ operation: "describe" }),
    messages: Object.freeze({
      identity: () => invoke({ operation: "messages.identity" }),
      search: (query) => invoke({ operation: "messages.search", query }),
      history: (query) => invoke({ operation: "messages.history", query }),
      thread: (query) => invoke({ operation: "messages.thread", query }),
    } satisfies ConnectorClient["messages"]),
    environments: Object.freeze({
      list: () => invoke({ operation: "environments.list" }),
      workloads: (name, namespace) => invoke({ operation: "environments.workloads", name, namespace }),
      get: (name: string) => invoke({ operation: "environments.get", name }),
    } satisfies ConnectorClient["environments"]),
    requirements: Object.freeze({
      list: (source, query) => invoke({ operation: "requirements.list", source, ...(query ? { query } : {}) }),
      get: (identity) => invoke({ operation: "requirements.get", identity }),
      identity: (source) => invoke({ operation: "requirements.identity", source }),
      comments: (identity, query) => invoke({ operation: "requirements.comments", identity, ...(query ? { query } : {}) }),
    } satisfies ConnectorClient["requirements"]),
    forges: Object.freeze({
      scanPullRequests: (forge, query) => invoke({ operation: "forges.scanPullRequests", forge, query }),
      listPullRequests: (forge, query) => invoke({ operation: "forges.listPullRequests", forge, query }),
      getPullRequest: (key) => invoke({ operation: "forges.getPullRequest", key }),
      getPullRequestReview: (key) => invoke({ operation: "forges.getPullRequestReview", key }),
      listPullRequestComments: (key) => invoke({ operation: "forges.listPullRequestComments", key }),
    } satisfies ConnectorClient["forges"]),
  } satisfies ConnectorClient);
}

export function dispatchConnector(client: ConnectorClient, request: ConnectorRequest): Promise<unknown> {
  switch (request.operation) {
    case "describe": return client.describe();
    case "messages.identity": return client.messages.identity();
    case "messages.search": return client.messages.search(request.query);
    case "messages.history": return client.messages.history(request.query);
    case "messages.thread": return client.messages.thread(request.query);
    case "environments.list": return client.environments.list();
    case "environments.workloads": return client.environments.workloads(request.name, request.namespace);
    case "environments.get": return client.environments.get(request.name);
    case "requirements.list": return client.requirements.list(request.source, request.query);
    case "requirements.get": return client.requirements.get(request.identity);
    case "requirements.identity": return client.requirements.identity(request.source);
    case "requirements.comments": return client.requirements.comments(request.identity, request.query);
    case "forges.scanPullRequests": return client.forges.scanPullRequests(request.forge, request.query);
    case "forges.listPullRequests": return client.forges.listPullRequests(request.forge, request.query);
    case "forges.getPullRequest": return client.forges.getPullRequest(request.key);
    case "forges.getPullRequestReview": return client.forges.getPullRequestReview(request.key);
    case "forges.listPullRequestComments": return client.forges.listPullRequestComments(request.key);
  }
}

/** Hosts without configured connectors still expose the same discoverable capability. */
export const emptyConnectors = createConnectorClient(async <T>(request: ConnectorRequest): Promise<T> => {
  if (request.operation === "describe") return { environments: [], requirements: [], forges: [] } as T;
  if (request.operation === "environments.list") return [] as T;
  throw new Error("Connector is not configured");
});
