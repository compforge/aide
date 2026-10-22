# @compforge/aide-plugin

Public, host-independent contracts for Aide plugins. A plugin defines resources and business callbacks; Core owns persistence, scheduling and Harness execution; Runner schedules Controllers and Host owns durable state and external capabilities. The package contains types and small shared values, not a host or Runner implementation.

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

`context.runtime` exposes the execution environment. `context.dataDirs` provides `global` (package-wide) and `instance` directories for plugin-private files, independently of execution journals or cwd.

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

The runtime has no builtin resource types. Declare each domain resource in the plugin; Personal owns its Input, Output and Person models.

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

A [ReconcileContext](src/reconcile-context.ts) supplies snapshots and typed Core verbs. Action and Harness verbs return a closed outcome: success, dismissed, timeout or failure. The typed connector facade returns provider values and throws on failure or timeout.

```ts
const result = await execution.verbs.harness({ title: "Inspect", prompt: "Inspect this resource.", timeoutMs: 60_000 });
if (result.state === "success") {
  console.log(result.value.invocationId, result.value.result.finalText);
}
```

`execution.withContext(attributes)` attaches opaque application metadata to subsequent actions. The runtime persists it without interpreting business fields; Personal owns its conversation and input associations. The initiating resource identity is supplied by the runtime and cannot be changed by this metadata.

Controllers use `execution.verbs.connectors({ timeoutMs })` for connector actions. Other components may use `context.connectors` directly. Connector timeout ends the wait without promising cancellation of the underlying provider operation.

`execution.verbs.action(name, input)` invokes an application-registered capability in the current execution scope. Action names are scoped to the plugin instance. Personal supplies its own typed `say` helper; communication policy is not a generic runtime verb.

`resources.commit(writes)` atomically creates/replaces/patches resources in one plugin scope. Validation, quota or version failures roll everything back; notifications follow commit. External side effects cannot join this transaction.

`harness` creates a HarnessInvocation directly. Business ask, confirm, draft and Interaction contracts are removed. Native tool permissions and Hook trust remain explicit Host Approvals; requesting execution does not grant these permissions.

Application Harness context is derived from the main resource UID and Controller name. An explicit harnessTargetId selects a configured Target; otherwise the application default is used. `snapshot.harnessTargets` provides configuration discovery without Resource projections. `freshContext` replaces native context with the supplied bounded prompt and records a history cutoff.

Harness and connector calls require timeoutMs covering their wait. Waiting releases Controller and Runner capacity, but the async continuation remains in the Runner. Worker or host interruption fails the unfinished verb; the continuation is not replayed. Persist domain facts needed to decide what to do after restart.

Harness returns an invocation ID and execution result. Reconcile snapshots contain only cwd and configured Harness targets, never global execution history. ApplicationRuntime always provides resource scheduling; an optional `harness` configuration enables ExecutionService. Resource-only plugins need no adapter or target configuration. Resource contexts retain native bindings and history cutoffs. Every Harness call has one invocation ID for events, results, cancellation and approvals; no Lane or Turn object is created. Storage uses the current format without legacy journal conversion. See [execution boundary](../../docs/kernel.md#执行后端的边界).

## Resource Printers

[ResourceDefinition](src/resource.ts) is the declaration entrypoint for type, schema, optional validators, Printer and retention. Declare resources before activation. For an isolated Runner, the Host package entry supplies `resourcesUrl`, a pure module whose default export is the definition array; in-process plugins use `PluginPackage.resources`. The Host loads definitions before restoration and Controllers, independently of the Runner lifetime.

```ts
import type { ResourceDefinition } from "@compforge/aide-plugin";

const definition: ResourceDefinition<{ title: string }, { phase?: string }> = {
  type: EXAMPLE,
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

Schema parsers synchronously validate and return canonical spec/status values. Optional create/update/delete validators run inside the storage transaction; their context lists current resources in the same scope, including preceding writes in a commit. Failures roll back writes and notifications. Unknown resource types reject. Every resource belongs to the plugin instance and namespace; resource identities and selectors have no sessionId. Controllers are optional and registered separately.

Printer methods synchronously return strings from a supplied snapshot. Definition callbacks are trusted Host code: they must not perform I/O, call models, mutate resources or return Promises. Resource instances remain serializable data; functions are never stored in spec/status. Printer output is text, not trusted markup.

Use `await context.printers.describe(resource)` / `summarize(resource)` wherever text is needed. Host callers use `manager.describeResource(pluginInstanceId, resource)` / `summarizeResource(...)`. Runner sends the snapshot over IPC; Host executes the Printer on a copy without re-fetching it or starting a Reconcile. Definitions remain available after Runner failure or shutdown.

Definitions resolve by Plugin Instance and apiVersion/kind. A plugin cannot claim another plugin's type. Without a Printer, details use indented JSON and summaries use kind/name. A Printer error is logged and propagated rather than replaced with fallback output.

Retention rules belong to the same definition. `releasedAt` returns eligibility time, or undefined to protect the resource; `references` returns exact resource UIDs. Host applies quotas and eviction ordering only to released, unreferenced resources. Missing declarations protect restored records; new writes require declarations.


## Execution hooks and diagnostics

[Hooks](src/hook.ts) observe two execution boundaries:

| Stage | Delivery |
| --- | --- |
| `harness.input` | Inline, before Adapter dispatch |
| `harness.output` | Deferred, after committing an execution event |

Inline hooks fail open on failure or timeout. Deferred hooks use best-effort bounded delivery. Hooks correlate observations by invocationId and return no replacement or allow/deny value. Their verbs expose actions and connectors; Harness execution belongs to resource Controllers. Publishing an output does not prove a person saw it.

`context.logger` writes host-owned structured diagnostics with plugin identity; log transitions and errors, avoid repeated polling noise and secrets, and do not use logs as business state.

See [Channel](../../docs/channel/README.md) for the current Web / Lark experience and [Kernel](../../docs/kernel.md) for execution ownership.

Controllers may set an optional `name` (lowercase letter followed by up to 63 lowercase letters, digits or hyphens) to observe the same resource kind with independent queues, locks and durable deadlines. Use explicit status Watches and resource-version checks to coordinate their separate responsibilities.
