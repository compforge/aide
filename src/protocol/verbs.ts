import type { ConnectorRequest } from "./connectors.ts";
import type { ExecutionAssociation } from "@compforge/aide-plugin";
import type { HarnessInvocationInput, HarnessResult, ResourceNamespace } from "@compforge/aide-plugin";

export interface ExecutionScope extends ExecutionAssociation {
  readonly controllerName?: string;
  readonly pluginInstanceId: string;
  /** Namespace of the resource that initiated the action. */
  readonly namespace: ResourceNamespace;
  /** Core-issued identity for one live Plugin execution. */
  readonly executionId: string;
}

/**
 * Controller action outlet. Plugin actions, Harness and connector calls
 * retain their execution deadlines. Other Core callers need not use Verb.
 */
export type VerbRequest =
  | { readonly verb: "action"; readonly name: string; readonly input: unknown }
  | { readonly verb: "connector"; readonly input: { readonly request: ConnectorRequest; readonly timeoutMs: number } }
  | {
      readonly verb: "harness";
      readonly input: HarnessInvocationInput;
    };

export type VerbResponse =
  | import("@compforge/aide-plugin").VerbResult<unknown>
  | HarnessResult;

export type InvokeVerb = (
  context: ExecutionScope,
  request: VerbRequest,
) => Promise<VerbResponse>;

