# @compforge/aide-plugin

Public, host-independent contracts for Aide plugins. A plugin defines resources and business callbacks; Core owns persistence, scheduling, interactions and Harness execution; Runner schedules Controllers and Host owns durable state and external capabilities. The package contains types and small shared values, not a host or Runner implementation.

See [plugin runtime](../../docs/plugin/README.md) for the process model and [Personal](../../docs/plugin/personal.md) for a built-in consumer. Start with the exported contracts in [src/index.ts](src/index.ts).

## A small plugin

```ts
import type { PluginPackage } from "@compforge/aide-plugin";

const EXAMPLE = { apiVersion: "example.aide.dev/v1alpha1", kind: "Example" } as const;

const plugin: PluginPackage = {
  pluginId: "example/plugin",
  version: "0.1.0",
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

## Verbs and interactions

A [ReconcileContext](src/reconcile-context.ts) supplies snapshots and typed Core verbs. Interaction and Harness verbs return a closed outcome: success, dismissed, timeout or failure. The typed connector facade returns provider values and throws on failure or timeout. A negative confirmation is a successful business value, not an execution error.

```ts
const decision = await execution.verbs.confirm({
  title: "Continue work",
  prompt: "Proceed with the proposed change?",
  timeoutMs: 60_000,
});
// Inspect the typed result before requesting any follow-up action.
```

`execution.withContext({ conversationId, inputId })` associates actions with their conversation independently of Harness selection. Core also records the initiating resource.

Controllers use `execution.verbs.connectors({ timeoutMs })` for connector actions. Other components may use `context.connectors` directly. Connector verbs do not create an Interaction; timeout ends the wait without promising cancellation of the underlying provider operation.

`say({ text })` persists an ordinary Message through the application message sink without opening an Interaction or waiting for delivery. Personal uses its Conversation outbox. With an inputId, it also associates the message with that Input. Use `execution.withContext({ conversationId, inputId })` to select the context.

`ask` and `confirm` collect a decision. `draft` lets the user edit proposed input; `harness` requests execution. Draft and Harness requests pass through a durable Interaction gate, which host policy may approve automatically. Only an approved or submitted action creates a HarnessInvocation.

For execution, `laneId` selects a Lane and `newLane: true` creates a side Lane. An explicit harnessTargetId pins the Target. A direct Harness request resolves an omitted Target immediately; a draft resolves it when submitted. The returned Turn records execution, not domain acceptance.

Every verb requires timeoutMs covering its entire gate, queue and execution wait. Waiting releases Controller and Runner capacity, but the async continuation remains in the Runner. Worker or host interruption fails the unfinished verb; the continuation is not replayed. Persist domain facts needed to decide what to do after restart.

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
