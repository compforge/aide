import { AideError, aideErrorDetails, type AideErrorOptions } from "@compforge/aide-common";

/** Stable native identity. Harness owns persistence and resolves this ID after restart. */
export interface AgentStatus {
  readonly harness: string;
  readonly sessionId?: string;
}

export interface HarnessErrorOptions extends AideErrorOptions {
  /** Preserve the native recovery identity even when execution fails. */
  readonly agent?: AgentStatus;
}

/**
 * @spec Harness failures cross process boundaries as structured errors, not successful execution results.
 * @rule retryable never authorizes replaying a whole invocation with potentially completed tools.
 * @link docs/errors.md
 * @case tests/aide-error.test.ts
 */
export class HarnessError extends AideError {
  override readonly name = "HarnessError";
  readonly agent?: AgentStatus;
  constructor(options: HarnessErrorOptions) {
    super(options);
    this.agent = options.agent;
  }

  static from(error: unknown, agent?: AgentStatus): HarnessError {
    const details = harnessErrorDetails(error);
    return new HarnessError({ ...(details ?? aideErrorDetails(error) ?? {
      code: "harness_operation_failed", retryable: false,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 4000) || "Harness operation failed",
    }), ...(agent ? { agent } : {}) });
  }
}

/** Recognize another SDK copy and plain wire data without relying on constructor identity. */
export function harnessErrorDetails(error: unknown): HarnessErrorOptions | undefined {
  const details = aideErrorDetails(error);
  if (!details || !error || typeof error !== "object" || !("name" in error) || error.name !== "HarnessError") return;
  const agent = "agent" in error ? error.agent : undefined;
  if (agent === undefined) return details;
  if (!agent || typeof agent !== "object" || !("harness" in agent) || typeof agent.harness !== "string" || !agent.harness) return;
  const sessionId = "sessionId" in agent ? agent.sessionId : undefined;
  if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId)) return;
  return { ...details, agent: { harness: agent.harness, ...(sessionId ? { sessionId } : {}) } };
}
