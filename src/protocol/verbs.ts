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

export interface ExecutionScope {
  readonly aideSessionId: string;
  readonly pluginInstanceId: string;
  /** Namespace of the Resource or session boundary that initiated the action. */
  readonly namespace: ResourceNamespace;
  /** Core-issued identity for one live Plugin execution. */
  readonly executionId: string;
}

/**
 * Plugin-facing typed Core verbs. Every operation-producing verb first becomes
 * an Interaction; draft/harness create a HarnessInvocation only after that gate
 * settles positively. Runner never sends an opaque message.
 */
export type VerbRequest =
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
  | HarnessResult;

export type InvokeVerb = (
  context: ExecutionScope,
  request: VerbRequest,
) => Promise<VerbResponse>;

