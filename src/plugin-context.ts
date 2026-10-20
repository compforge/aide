import { createConnectorClient } from "./connector-client.ts";
import {
  MAX_VERB_TIMEOUT_MS,
  type AskInput,
  type AskResult,
  type AskValue,
  type ConfirmInput,
  type ConfirmResult,
  type DraftInput,
  type DraftResult,
  type HarnessInvocationInput,
  type HarnessResult,
  type HookContext,
  type HookStage,
  type HookSubjectMap,
  type PluginVerbs,
  type ReconcileContext,
  type ReconcileSnapshot,
} from "@compforge/aide-plugin";

import type { ExecutionScope, InvokeVerb } from "./protocol/verbs.ts";

const reconcileScopes = new WeakMap<ReconcileContext, ExecutionScope>();
const hookScopes = new WeakMap<HookContext, ExecutionScope>();

function nonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

function validateAsk(input: AskInput): void {
  validateTimeout("ask", input.timeoutMs);
  nonEmpty("ask title", input.title);
  nonEmpty("ask prompt", input.prompt);
  if (input.choices === undefined) {
    if (input.allowOther !== true) {
      throw new Error("ask without choices must set allowOther to true");
    }
    return;
  }
  if (input.choices.length === 0) {
    throw new Error("ask choices must not be empty");
  }
  const values = new Set<string>();
  for (const choice of input.choices) {
    nonEmpty("ask choice value", choice.value);
    nonEmpty("ask choice label", choice.label);
    if (values.has(choice.value)) {
      throw new Error(`ask choice value is duplicated: ${choice.value}`);
    }
    values.add(choice.value);
  }
}

function validateConfirm(input: ConfirmInput): void {
  validateTimeout("confirm", input.timeoutMs);
  nonEmpty("confirm title", input.title);
  nonEmpty("confirm prompt", input.prompt);
  if (input.confirmLabel !== undefined) {
    nonEmpty("confirm confirmLabel", input.confirmLabel);
  }
  if (input.declineLabel !== undefined) {
    nonEmpty("confirm declineLabel", input.declineLabel);
  }
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
  nonEmpty("harness laneId", input.laneId);
  if (input.newLane !== undefined && typeof input.newLane !== "boolean") {
    throw new Error(`harness newLane is invalid: ${String(input.newLane)}`);
  }
  if (input.harnessTargetId !== undefined) {
    nonEmpty("harness harnessTargetId", input.harnessTargetId);
  }
}

function validateDraft(input: DraftInput): void {
  validateTimeout("draft", input.timeoutMs);
  nonEmpty("draft title", input.title);
  nonEmpty("draft prompt", input.prompt);
  if (input.harnessTargetId !== undefined) {
    nonEmpty("draft harnessTargetId", input.harnessTargetId);
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
    async say(input: import("@compforge/aide-plugin").SayInput) {
      nonEmpty("say text", input.text);
      return await invoke(scope, { verb: "say", input }) as import("@compforge/aide-plugin").SayResult;
    },
    connectors(options: { timeoutMs: number }) {
      validateTimeout("connector", options.timeoutMs);
      return createConnectorClient(async <T>(request: import("./protocol/connectors.ts").ConnectorRequest): Promise<T> => {
        const result = await invoke(scope, { verb: "connector", input: { request, timeoutMs: options.timeoutMs } });
        if (result.state !== "success") throw new Error(`Connector ${request.operation} ${result.state}${result.state === "failure" ? `: ${result.error}` : ""}`);
        return result.value as T;
      });
    },
    async ask<const TInput extends AskInput>(input: TInput) {
      validateAsk(input);
      return await invoke(scope, {
        verb: "ask",
        input,
      }) as AskResult<AskValue<TInput>>;
    },
    async confirm(input: ConfirmInput) {
      validateConfirm(input);
      return await invoke(scope, {
        verb: "confirm",
        input,
      }) as ConfirmResult;
    },
    async draft(input: DraftInput) {
      validateDraft(input);
      return await invoke(scope, {
        verb: "draft",
        input,
      }) as DraftResult;
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
    withContext: (association: Pick<import("@compforge/aide-plugin").ExecutionAssociation, "conversationId" | "inputId">) => createReconcileContext(snapshot, { ...scope, ...association }, invoke),
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
  const context = Object.freeze({
    stage,
    subject,
    snapshot,
    verbs: createPluginVerbs(scope, invoke),
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

