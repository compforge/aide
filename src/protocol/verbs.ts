import type { ConnectorRequest } from "./connectors.ts";
import type { ExecutionAssociation } from "@compforge/aide-plugin";
import type {
  AskInput,
  AskResult,
  ConfirmInput,
  ConfirmResult,
  DraftInput,
  DraftResult,
  HarnessInvocationInput,
  HarnessResult,
  ResourceNamespace,
} from "@compforge/aide-plugin";

export interface ExecutionScope extends ExecutionAssociation {
  readonly controllerName?: string;
  readonly aideSessionId: string;
  readonly pluginInstanceId: string;
  /** Namespace of the Resource or session boundary that initiated the action. */
  readonly namespace: ResourceNamespace;
  /** Core-issued identity for one live Plugin execution. */
  readonly executionId: string;
}

/**
 * Controller action outlet. Connector calls run directly; human interactions and
 * Harness gates keep their own lifecycle. Other Core callers need not use Verb.
 */
export type VerbRequest =
  | { readonly verb: "say"; readonly input: import("@compforge/aide-plugin").SayInput }
  | { readonly verb: "connector"; readonly input: { readonly request: ConnectorRequest; readonly timeoutMs: number } }
  | {
      readonly verb: "ask";
      readonly input: AskInput;
    }
  | {
      readonly verb: "confirm";
      readonly input: ConfirmInput;
    }
  | {
      readonly verb: "draft";
      readonly input: DraftInput;
    }
  | {
      readonly verb: "harness";
      readonly input: HarnessInvocationInput;
    };

export type VerbResponse =
  | AskResult
  | ConfirmResult
  | DraftResult
  | import("@compforge/aide-plugin").VerbResult<unknown>
  | HarnessResult;

export type InvokeVerb = (
  context: ExecutionScope,
  request: VerbRequest,
) => Promise<VerbResponse>;

