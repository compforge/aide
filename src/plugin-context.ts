import { createConnectorClient } from "./connector-client.ts";
import { MAX_VERB_TIMEOUT_MS, type HarnessInvocationInput, type HarnessResult, type HookContext, type HookStage, type HookSubjectMap, type PluginVerbs, type ReconcileContext, type ReconcileSnapshot } from "@compforge/aide-plugin";

import type { ExecutionScope, InvokeVerb } from "./protocol/verbs.ts";

const reconcileScopes = new WeakMap<ReconcileContext, ExecutionScope>();
const hookScopes = new WeakMap<HookContext, ExecutionScope>();

function nonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function validateTimeout(name: string, timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error(`${name} timeoutMs must be a positive integer`);
  }
  if (timeoutMs > MAX_VERB_TIMEOUT_MS) {
    throw new Error(
      `${name} timeoutMs must not exceed ${MAX_VERB_TIMEOUT_MS}`,
    );
  }
}

function validateHarness(input: HarnessInvocationInput): void {
  validateTimeout("harness", input.timeoutMs);
  nonEmpty("harness title", input.title);
  nonEmpty("harness prompt", input.prompt);
  if (input.freshContext !== undefined && typeof input.freshContext !== "boolean") throw new Error("Invalid freshContext");
  if (input.harnessTargetId !== undefined) {
    nonEmpty("harness harnessTargetId", input.harnessTargetId);
  }
}

/**
 * @spec Host and Runner use the same facade; only the invocation transport differs.
 * @rule Context construction depends only on the public Plugin contract, never Host execution or storage.
 * @see {@link ../docs/kernel.md}
 */
export function createPluginVerbs(
  scope: ExecutionScope,
  invoke: InvokeVerb,
): PluginVerbs {
  return Object.freeze({
    async action<T>(name: string, input: unknown) {
      nonEmpty("action name", name);
      return await invoke(scope, { verb: "action", name, input }) as import("@compforge/aide-plugin").VerbResult<T>;
    },
    connectors(options: { timeoutMs: number }) {
      validateTimeout("connector", options.timeoutMs);
      return createConnectorClient(async <T>(request: import("./protocol/connectors.ts").ConnectorRequest): Promise<T> => {
        const result = await invoke(scope, { verb: "connector", input: { request, timeoutMs: options.timeoutMs } });
        if (result.state !== "success") throw new Error(`Connector ${request.operation} ${result.state}${result.state === "failure" ? `: ${result.error}` : ""}`);
        return result.value as T;
      });
    },
    async harness(input: HarnessInvocationInput) {
      validateHarness(input);
      return await invoke(scope, {
        verb: "harness",
        input,
      }) as HarnessResult;
    },
  });
}

export function createReconcileContext(
  snapshot: ReconcileSnapshot,
  scope: ExecutionScope,
  invoke: InvokeVerb,
): ReconcileContext {
  const context: ReconcileContext = Object.freeze({
    executionId: scope.executionId,
    withContext: (attributes: Readonly<Record<string, unknown>>) => createReconcileContext(snapshot, { ...scope, attributes: Object.freeze(structuredClone(attributes)) }, invoke),
    snapshot,
    verbs: createPluginVerbs(scope, invoke),
  });
  reconcileScopes.set(context, scope);
  return context;
}

export function createHookContext<S extends HookStage>(
  stage: S,
  subject: Readonly<HookSubjectMap[S]>,
  snapshot: ReconcileSnapshot,
  scope: ExecutionScope,
  invoke: InvokeVerb,
): HookContext<S> {
  const { harness: _harness, ...verbs } = createPluginVerbs(scope, invoke);
  const context = Object.freeze({
    stage,
    subject,
    snapshot,
    verbs: Object.freeze(verbs),
  });
  hookScopes.set(context, scope);
  return context;
}

export function reconcileScope(context: ReconcileContext): ExecutionScope {
  const scope = reconcileScopes.get(context);
  if (!scope) throw new Error("reconcile scope is unavailable");
  return scope;
}

export function reconcileSnapshot(context: ReconcileContext): ReconcileSnapshot {
  return context.snapshot;
}

export function hookScope(context: HookContext): ExecutionScope {
  const scope = hookScopes.get(context);
  if (!scope) throw new Error("hook scope is unavailable");
  return scope;
}

