# @compforge/aide-plugin

Public, host-independent contracts for Aide plugins. A plugin defines resources and business callbacks; Core owns persistence, scheduling, Outputs and Harness execution; Runner schedules Controllers and Host owns durable state and external capabilities. The package contains types and small shared values, not a host or Runner implementation.

See [plugin runtime](../../docs/plugin/README.md) for the process model and [Personal](../../docs/plugin/personal.md) for a built-in consumer. Start with the exported contracts in [src/index.ts](src/index.ts).

## A small plugin

```ts
import type { PluginPackage } from "@compforge/aide-plugin";
import { z } from "zod";

const EXAMPLE = { apiVersion: "example.aide.dev/v1alpha1", kind: "Example" } as const;

const plugin: PluginPackage = {
  pluginId: "example/plugin",
  version: "0.1.0",
  resources: [{
    type: EXAMPLE,
    scope: "session",
    schema: {
      spec: z.object({ title: z.string() }).strict(),
      status: z.object({ phase: z.string().optional() }).strict(),
    },
  }],
  async activate(context) {
    context.controllers.register<{ title: string }, { phase?: string }>({
      resourceType: EXAMPLE,
      sources: [{
        type: "resource",
        sourceId: "initial",
        async start(source) {
          await source.emit({ name: "hello", spec: { title: "Hello" } });
        },
      }],
      async reconcile(_execution, resource) {
        if (resource.metadata.deletionTimestamp || resource.status.phase === "done") return;
        context.logger.info("Example observed", { attributes: { name: resource.metadata.name } });
        await context.resources.patchStatus(resource, { phase: "done" });
      },
    });
  },
};

export default plugin;
```

`context.dataDirs` provides `global` (shared across Sessions), `session`, and `instance` directories for plugin-private files. Session storage is independent of execution cwd; there is no project directory scope.

An enabled instance has a host Binding and a Runner process. Register capabilities during activation and use `context.lifecycle.onClose` for cleanup. A plugin may manage resources in different namespaces; scope belongs to each resource, not to the package.

## Global connectors

`context.connectors` exposes host-owned read capabilities to every plugin. The host loads one configuration snapshot; Runner calls use the existing IPC transport. A plugin does not load provider credentials or construct provider clients.

```ts
const catalog = await context.connectors.describe();
const environments = await context.connectors.environments.list();
const environment = await context.connectors.environments.get("dev");
const snapshot = await context.connectors.environments.workloads("dev", "app");
```

Environment names and aliases resolve to a canonical name. Listing returns compact declarations; reading returns access coordinates, without opening kubeconfig files or connecting to the target. Unknown targets reject. The Environment / Host identity contracts come from `@compforge/harness-common`; no toolbox access lifecycle is implied.

Requirements and forges expose typed list / get operations, with forge comments available separately. Connectors are global capabilities, while a plugin's observation policy belongs in its instance config. See [Connector configuration](../../docs/connector/README.md).

## Resources and scheduling

Core `InputSpec.sender` optionally references the sender resource; system events and mixed-author observations may omit it. A Person profile holds no Input references.

Core `InputSpec.relation` optionally records `sent`, `received` or `observed` relative to the served Person.
Omit it when identity evidence is insufficient. Receiving or observing content does not imply endorsement,
delegation or that the person read it. Producers retain original authorship and per-message evidence alongside the classification.
Person bindings and classification policy belong to Personal; Core validates and persists the result.

[ResourceClient](src/resource.ts) provides create, get, list, patch, status update and deletion. Namespace defaults to user-global `v1`; list can include descendants and match exact label values. Annotations are opaque metadata, while labels support selection.

Read by a resource reference:

```ts
const current = await context.resources.get({
  ...EXAMPLE,
  namespace: resource.metadata.namespace,
  name: resource.metadata.name,
  uid: resource.metadata.uid,
});
if (!current) return;
```

Include uid when continuing after an asynchronous wait so a same-name replacement is not mistaken for the original resource. Omit uid only for an intentional name lookup. Updates check resourceVersion; re-read current state before retrying a conflict. Do not retry external execution merely because its result commit conflicted.

All business mutations, including host-bound agent tools, use ResourceClient so secondary Watches see the same changes. Create accepts initial status; replace atomically updates spec and status against a resource version. Primary reconciliation follows creation, spec/metadata changes and deletion. Status-only changes remain visible to explicit Watches without automatically waking the primary controller.

A resource may have one structural owner in the same concrete namespace. Ownership includes uid; it is not a provenance link. Deletion persists deletionTimestamp, cascades to structural descendants and waits for successful terminating reconciliation before removing the resource.

[Controller](src/reconcile.ts) owns one resource type and its reconcile policy. Resource changes, watches, source emissions and requeue requests feed the same keyed queue. One resource reconciles serially.

- [Source](src/source.ts) performs initial discovery and live subscription. `start` resolves when ready; its signal is aborted on close. Identical emissions wake an existing resource, while implicit spec changes are rejected.
- CronSource periodically enqueues current resources of its Controller.
- [Watch](src/watch.ts) maps changes to secondary resources into primary requests. For updates, consider both old and new relationships so removed links also wake their former owner.
- `requeueAfterMs` schedules a later observation without a separate timer loop in the plugin.

Status belongs to the plugin. [ConditionedStatus](src/condition.ts) optionally represents current conditions, with one entry per type and transition time changing only when the condition status changes. The host does not interpret domain completion.

## Verbs and execution

A [ReconcileContext](src/reconcile-context.ts) supplies snapshots and typed Core verbs. Say and Harness verbs return a closed outcome: success, dismissed, timeout or failure. The typed connector facade returns provider values and throws on failure or timeout.

```ts
const result = await execution.verbs.say({ text: "Which environment should I use?" });
// The user can answer with a new Input; this execution does not wait for a reply.
```

`execution.withContext({ conversationId, inputId, inputIds })` associates actions with their conversation independently of Harness selection. Core also records the initiating resource.

Controllers use `execution.verbs.connectors({ timeoutMs })` for connector actions. Other components may use `context.connectors` directly. Connector timeout ends the wait without promising cancellation of the underlying provider operation.

`say({ text, inputIds?, respondToInputId?, target?, receivers?, idempotencyKey? })` persists an independent Output and returns `outputId`, without waiting for a reply or delivery. Input associations are optional and many-to-many; an omitted inputIds uses the execution inputId when present. A repeated idempotencyKey within the same Conversation incarnation and execution resolves to the same immutable Output. Use `execution.withContext({ conversationId, inputId, inputIds })` to select the context.

`resources.commit(writes)` atomically creates/replaces/patches local plugin resources together with Core Output creation. Plugin writes share one concrete resource scope (one Session or the plugin shared scope) and storage transaction; validation, quota or version failures roll everything back. Notifications follow commit. Other Core mutations and external side effects cannot join this transaction. Output is readable through ResourceClient and has a Host Printer; only Host delivery updates its status. See [Output](../../docs/output.md).

`harness` creates a HarnessInvocation directly. Business ask, confirm, draft and Interaction contracts are removed. Native tool permissions and Hook trust remain explicit Host Approvals; requesting execution does not grant these permissions.

For execution, `laneId` selects a Lane and `newLane: true` creates a side Lane. An explicit harnessTargetId pins the Target; otherwise the selected Target is resolved before dispatch. The returned Turn records execution, not domain acceptance.

Harness and connector calls require timeoutMs covering their wait; say only waits for Output persistence. Waiting releases Controller and Runner capacity, but the async continuation remains in the Runner. Worker or host interruption fails the unfinished verb; the continuation is not replayed. Persist domain facts needed to decide what to do after restart.

## Communication addresses

```ts
interface Address { readonly kind: string }
interface ChannelAddress extends Address {
  readonly kind: "channel";
  readonly channelId: string;
  readonly endpoint: string;
}
```

`InputSpec.sender` and `OutputSpec.receivers` reference Persons using ResourceRef; receivers is an optional array with at most 100 references, each pinned by uid. They describe who spoke and who the output is intended for, independently of its contributing Inputs and delivery location. Explicit receivers override the sender inferred by respondToInputId; [] selects no named receivers. Input associations alone do not infer receivers. Receivers do not produce additional sends or automatic platform mentions.

`InputSpec.source?: Address` describes a communication location, independently of sender Person, producer and sessionId. `OutputSpec.target: Address` is the selected immutable destination. Address is the parent interface; ChannelAddress is its current implementation. Host admission currently supports Web and Lark channel addresses and rejects unsupported kinds. Web endpoints use the selected conversation ID; Lark endpoints join separately URI-encoded appId and chatId with `/`. Only the Channel interprets this encoding.

Personal initializes `ConversationSpec.address` only when a Channel Input creates the Conversation. Subsequent Inputs, Source observations and default routing never replace or fill it. `say.respondToInputId` selects an attached Input address; `say.target` selects an explicit address. They are mutually exclusive. With neither, immediate Input addresses must agree; without immediate Inputs, say uses the Conversation address. Missing or ambiguous destinations reject before publishing an Output.

## Resource Printers

[ResourceDefinition](src/resource.ts) is the declaration entrypoint for type, scope, schema, optional validators, Printer and retention. Declare resources before activation. For an isolated Runner, the Host package entry supplies `resourcesUrl`, a pure module whose default export is the definition array; in-process plugins use `PluginPackage.resources`. The Host loads definitions before restoration and Controllers, independently of the Runner lifetime.

```ts
import type { ResourceDefinition } from "@compforge/aide-plugin";

const definition: ResourceDefinition<{ title: string }, { phase?: string }> = {
  type: EXAMPLE,
  scope: "session",
  schema: {
    spec: z.object({ title: z.string() }).strict(),
    status: z.object({ phase: z.string().optional() }).strict(),
  },
  printer: {
    describe: r => `${r.metadata.name}: ${r.spec.title}\nPhase: ${r.status.phase ?? "pending"}`,
    summarize: r => r.spec.title,
  },
};
```

Schema parsers synchronously validate and return canonical spec/status values. Optional create/update/delete validators run inside the storage transaction; their context lists current resources in the same scope, including preceding writes in a commit. Failures roll back writes and notifications. Unknown resource types reject. A `shared` resource belongs to the plugin instance across Sessions and has no sessionId; a `session` resource belongs to one execution Session. Controllers are optional and registered separately.

Printer methods synchronously return strings from a supplied snapshot. Definition callbacks are trusted Host code: they must not perform I/O, call models, mutate resources or return Promises. Resource instances remain serializable data; functions are never stored in spec/status. Printer output is text, not trusted markup.

Use `await context.printers.describe(resource)` / `summarize(resource)` wherever text is needed. Host callers use `manager.describeResource(pluginInstanceId, resource)` / `summarizeResource(...)`. Runner sends the snapshot over IPC; Host executes the Printer on a copy without re-fetching it or starting a Reconcile. Definitions remain available after Runner failure or shutdown.

Core definitions resolve by exact apiVersion/kind; other definitions additionally use Plugin Instance. A plugin cannot claim a Core type or another plugin's type. Without a Printer, details use indented JSON and summaries use kind/name. A Printer error is logged and propagated rather than replaced with fallback output.

Retention rules belong to the same definition. `releasedAt` returns eligibility time, or undefined to protect the resource; `references` returns exact resource UIDs. Host applies quotas and eviction ordering only to released, unreferenced resources. Missing declarations protect restored records; new writes require declarations.

The Host supplies an Input Printer that preserves original text and optional evidence in descriptions and produces a whitespace-normalized preview of at most 120 Unicode code points. It remains available without an active plugin. Web input details and Chief current-input prompts use this description; Web keeps the full original message as its main content. Existing Board presentation remains a separate structured UI contract.

## Hooks, commands and presentation

[Hooks](src/hook.ts) observe four coordination boundaries:

| Stage | Delivery |
| --- | --- |
| `view.input` | Inline, before Core lowers the input |
| `harness.input` | Inline, before Adapter dispatch |
| `view.output` | Deferred, after publishing a view update |
| `harness.output` | Deferred, after committing an execution event |

Inline hooks fail open on failure or timeout. Deferred hooks use best-effort bounded delivery. Hooks return no replacement or allow/deny value; request effects through their typed verbs or writable resource fields. Publishing an output does not prove a person saw it.

[Commands](src/command.ts) receive invocation-scoped capabilities. Command verbs submit a turn or configure model defaults; capabilities expire with the invocation. Picker selections are new invocations, and remote search cannot retain a prior invocation's authority.

[Target and Session projections](src/resource.ts) expose host facts through the same resource API. Core registers its resource types before plugin activation. Model discovery belongs to Target; changing SessionTargetBinding is limited to supported fields and eligible Targets.

[Mentions](src/mention.ts) supply searchable, read-only context for explicit user selection. Keep search side-effect free; resolve is for selected references. [Board presentations](src/board.ts), pickers, mentions and toast are optional presentation contracts. Actual rendering depends on the consuming Channel; the current Web / Lark adapters do not expose every authoring capability.

`context.toast` is non-durable feedback. Ongoing state belongs in resource status. `context.logger` writes host-owned structured diagnostics with plugin identity; log transitions and errors, avoid repeated polling noise and secrets, and do not use logs as business state.

See [Channel](../../docs/channel/README.md) for the current Web / Lark experience and [Kernel](../../docs/kernel.md) for execution ownership.

Controllers may set an optional `name` (lowercase letter followed by up to 63 lowercase letters, digits or hyphens) to observe the same resource kind with independent queues, locks and durable deadlines. Use explicit status Watches and resource-version checks to coordinate their separate responsibilities.
