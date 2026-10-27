# @compforge/aide-connector

Public contracts for external operations in Aide. A Connector Kind defines asynchronous methods; a configured connection implements that Kind. Plugins, Reconcile callbacks and verbs discover connections and use the same typed methods without depending on their provider.

The package root contains generic contracts and client helpers. Domain contracts have separate entrypoints, each exporting its Kind and related types:

| Entrypoint | Kind |
| --- | --- |
| `@compforge/aide-connector/forge` | `ForgeKind` |
| `@compforge/aide-connector/environment` | `EnvironmentKind` |
| `@compforge/aide-connector/requirement` | `RequirementKind` |
| `@compforge/aide-connector/message` | `MessageKind` |

Both built-in and external implementations can implement these contracts; they do not form a closed Kind enum. Provider implementations live in the Host's `connectors/` directory or external packages. Source observation continues to use `@compforge/aide-plugin` Resource/Controller APIs.

## Runtime and TypeScript

Like `@compforge/aide-plugin`, this package ships TypeScript source for the Bun-based Aide runtime. Consumers that run `tsc --noEmit` should enable `allowImportingTsExtensions` in their TypeScript configuration.

## Define a Kind

```ts
import { defineConnectorKind } from "@compforge/aide-connector";

export interface Tickets {
  read(key: string): Promise<{ key: string; title: string }>;
}
export const TicketKind = defineConnectorKind<Tickets>({
  kind: "example.tickets",
  version: 1,
  methods: ["read"],
});
```

Kinds use explicit method names and contract versions. A Kind may also provide per-method `validation` schemas for argument tuples and results. Changing method semantics or signatures requires a contract-version change. Kind descriptors contain no credentials and are shared by consumers and implementations.

## Supply an implementation

A trusted Host-loaded module exports a default `ConnectorPackage`:

```ts
import type { ConnectorPackage } from "@compforge/aide-connector";
import { TicketKind } from "./contract.ts";

export default {
  id: "example-connectors",
  version: "1.0.0",
  connectors: [{
    type: "example-tickets",
    kind: TicketKind,
    config: {
      parse(value: unknown) {
        const config = value as { tokenEnv?: unknown };
        if (typeof config?.tokenEnv !== "string") throw new Error("tokenEnv required");
        return { tokenEnv: config.tokenEnv };
      },
    },
    create(context, config) {
      const token = context.env(config.tokenEnv);
      if (!token) throw new Error("Ticket credential missing");
      // Create the provider client here. Resolve environment dependencies during creation.
      return {
        metadata: { label: "Work tickets" },
        handlers: {
          async read(call, key) {
            // Use the provider client and call.signal; return serializable business facts.
            return { key, title: "Example" };
          },
        },
        close() { /* close the provider client */ },
      };
    },
  }],
} satisfies ConnectorPackage;
```

Each handler receives the Host call context first, followed by the Kind's ordinary arguments. `context.signal` belongs to the connection lifetime; `call.signal` belongs to an individual invocation. Handlers must honor cancellation and use bounded provider-client deadlines. A timeout cannot prove an external write did not happen; Aide never automatically replays interrupted operations.

Factories receive parsed private configuration and an immutable Host environment accessor. `env()` reads bind the access revision and must be resolved during creation. Only explicitly declared public metadata crosses discovery; configuration and environment values are not included. Connector modules are trusted Host code, not a security sandbox.

## Discover and use

```ts
for (const connection of await context.connectors.list(TicketKind)) {
  const tickets = context.connectors.get(TicketKind, connection);
  const ticket = await tickets.read("ISSUE-1");
}
```

An execution-scoped client uses the same API:

```ts
const access = execution.verbs.connectors({ timeoutMs: 30_000 });
for (const connection of await access.list(TicketKind)) {
  await access.get(TicketKind, connection).read("ISSUE-1");
}
```

Descriptions contain Kind, contract version, name, opaque revision, method names and public metadata. Names are unique within a Kind. References pin the selected connection revision and contract version; replacing a connection cannot silently redirect an old client. Callers should discover again after configuration changes. A description means locally registered, not verified remote health.

Only plain JSON facts cross the boundary. Optional object fields with undefined values are omitted; unsupported values and cyclic data fail explicitly. Direct and IPC calls use the same canonical representation.

## Loading and lifecycle

The Aide Host loads explicitly configured local modules or installed npm packages; it does not download packages. Each enabled configuration creates one working connection. Duplicate names/types, incompatible contracts and invalid configuration fail during assembly. Partial assembly rolls back already created connections.

All callers of one connection share `maxConcurrentCalls` and `maxQueuedCalls`. A deadline includes queue wait, and timed-out queued calls never start. These are invocation-capacity limits; they do not claim to limit every HTTP request inside an implementation. Request rate/burst controls remain future work and should reuse provider transports.

Disabling a connection takes effect on restart. Host registry removal aborts queued and active calls, then closes the implementation. Dynamic configuration reload, persistent Connector Resources and a separate Source SDK are not part of this contract.

Configuration and implementation details: [Connector extensions](../../docs/connector/extensions.md).
