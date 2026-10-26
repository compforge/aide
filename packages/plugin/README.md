# @compforge/aide-plugin

Public, host-independent contracts for Aide plugins. A plugin defines resources and business callbacks; Core owns persistence, scheduling and Harness execution; Runner schedules Controllers and Host owns durable state and external capabilities. The package contains types and small shared values, not a host or Runner implementation.

See [plugin runtime](../../docs/plugin/README.md) for the process model and [Personal](../../docs/personal/README.md) for a built-in consumer. Start with the exported contracts in [src/index.ts](src/index.ts).

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

Requirements and forges expose typed list / get operations, with forge comments available separately. Forge references and query/comment types come from `@compforge/repocli`, whose Repository / PullRequest facts use `@compforge/harness-common`. `PullRequestObservation` is re-exported from repocli and extends common's serializable `PullRequestSnapshot`; it has `repository`, `number` and `state`, and excludes identity methods. Plugins use the Host Connector and do not instantiate repocli clients.

```ts
const pull = await context.connectors.forges.get({
  repository: { forge: { name: "github.com" }, path: "org/repo" }, number: 7,
});
// pull.state is open / merged / closed; no id() methods cross IPC.
```

Version 0.14 replaces the former flattened `PullRequestIdentity` and `PullRequest.lifecycle` with this shared reference and observation shape. Connectors are global capabilities, while a plugin's observation policy belongs in its instance config. See [Connector configuration](../../docs/connector/README.md).

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

`execution.withContext(attributes)` attaches opaque application metadata to subsequent actions. The runtime persists it without interpreting business fields; Personal owns its topic and input associations. The initiating resource identity is supplied by the runtime and cannot be changed by this metadata.

Controllers use `execution.verbs.connectors({ timeoutMs })` for connector actions. Other components may use `context.connectors` directly. Connector timeout ends the wait without promising cancellation of the underlying provider operation.

`execution.verbs.action(name, input)` invokes an application-registered capability in the current execution scope. Action names are scoped to the plugin instance. Personal supplies its own typed `say` helper; communication policy is not a generic runtime verb.

`resources.commit(writes)` atomically creates/replaces/patches resources and requests deletion in one plugin scope. A `{ operation: "delete", resource }` write checks the snapshot's UID and resourceVersion, marks the resource and its descendants for deletion, and returns the marked resource; normal reconciliation performs final removal. Validation, quota or version failures roll everything back; notifications follow commit. External side effects cannot join this transaction.

Verb is the common outlet for non-CRD operations; ResourceClient owns CRD access. Each call has correlated diagnostics (call ID, execution ID, resource UID, operation, duration and outcome). These records do not store or recover native agent history.

`harness` wraps the Harness interface without a Binding or Agent interface. Default `prompt` creates a HarnessInvocation and waits for its execution result. Session operations (`create`, `resume`, `close`, `abort`) and native input operations (`followUp`, `steer`) return acceptance receipts. Unsupported optional operations are explicitly rejected. Business ask, confirm, draft and Interaction contracts are removed. Native tool permissions and Hook trust remain explicit Host Approvals.

```ts
const agent = resource.status.agent; // Application-owned storage, not a Host convention.
const result = await execution.verbs.harness({
  ...agent, title: "Review new input", prompt: inputText, timeoutMs: 30_000,
});
// The Operator decides where to save result.agent, including references returned after failure.
await execution.verbs.harness({
  operation: "followUp", invocationId, messageId: inputId, prompt: inputText, timeoutMs: 30_000,
});
```

The harness parameter selects startup configuration; snapshot.harnesses discovers available configurations. A prompt without session creates a new native session. With session it reuses or restores that native session. Resume alone does not execute or replay input. Runtime IDs and invocation IDs are ephemeral correlation only.

Harness and connector calls require timeoutMs covering their wait. Waiting releases Controller and Runner capacity, but the async continuation remains in the Runner. Worker or host interruption fails the unfinished verb; the continuation is not replayed. Persist domain facts needed to decide what to do after restart.

Harness inference returns an invocation ID and execution result. Reconcile snapshots contain only cwd and configured Harness targets, never global execution history. ApplicationRuntime always provides resource scheduling; optional Harness configuration enables ExecutionService. Resource-only plugins need no adapter or target configuration. Native input operations refer to an invocation owned by the calling resource; they do not start a second host inference queue. Session operations do not fabricate invocations. See [execution boundary](../../docs/kernel.md#执行后端的边界).

## Resource Printers

[ResourceDefinition](src/resource.ts) is the declaration entrypoint for type, schema, optional validators, Printer, indexes and retention. Declare resources before activation. For an isolated Runner, the Host package entry supplies `resourcesUrl`, a pure module whose default export is the definition array; in-process plugins use `PluginPackage.resources`. The Host loads definitions before restoration and Controllers, independently of the Runner lifetime.

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

Resource definitions can declare pure multi-value `indexes`, queried with `resources.list(type, { matchIndex: { name, value } })`. The Host updates indexes transactionally, rebuilds them when loading definitions, and removes them with the resource. Queries remain scoped to the plugin, resource type and namespace; unknown indexes are errors.

### Native agent recovery

The Operator may persist AgentStatus = { harness, sessionId? } anywhere its schema permits. Harness verbs accept these values as parameters and return known references in result.agent; the Host never reads or patches resource status. Personal Route / Chief / Task call create and persist the returned reference before a long-running prompt. If persistence fails, they close the runtime without dispatching input. Providers that cannot publish a native identity during create reject that operation; a one-shot prompt can still return a reference learned during execution. Native history and checkpoints remain owned by the Harness.

Resource deletion accepts optional `{ uid, resourceVersion }` preconditions as the fourth argument to `resources.delete(type, name, namespace, preconditions)`. Check and deletion marking occur in the same transaction. Idle collection uses this guard so a newly assigned input invalidates an older collection decision. Once deletionTimestamp is set, mutations cannot resume that resource.
