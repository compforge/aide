import { AideError, aideErrorDetails, type AideErrorOptions } from "@compforge/aide-common";

/** Stable native identity. Harness owns persistence and resolves this ID after restart. */
export interface AgentStatus {
  readonly harness: string;
  readonly sessionId?: string;
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
  constructor(details: AideErrorOptions, agent?: AgentStatus) {
    super(details);
    this.agent = agent;
  }

  static from(error: unknown, agent?: AgentStatus): HarnessError {
    const known = asHarnessError(error);
    return new HarnessError(known ?? aideErrorDetails(error) ?? {
      code: "harness_operation_failed", retryable: false,
      message: (error instanceof Error ? error.message : String(error)).slice(0, 4000) || "Harness operation failed",
    }, agent ?? known?.agent);
  }
}

/** New Harness failures do not authorize replaying an invocation. */
export function newHarnessError(code: string, message: string, agent?: AgentStatus): HarnessError {
  return new HarnessError({ code, message, retryable: false }, agent);
}

/** Recognize another SDK copy and wire data; the caller receives an Error, not construction options. */
export function asHarnessError(error: unknown, fallbackAgent?: AgentStatus): HarnessError | undefined {
  const details = aideErrorDetails(error);
  if (!details || !error || typeof error !== "object" || !("name" in error) || error.name !== "HarnessError") return;
  const value = "agent" in error ? error.agent : undefined;
  let agent = fallbackAgent;
  if (value !== undefined) {
    if (!value || typeof value !== "object" || !("harness" in value) || typeof value.harness !== "string" || !value.harness) return;
    const sessionId = "sessionId" in value ? value.sessionId : undefined;
    if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId)) return;
    if (sessionId || !agent) agent = { harness: value.harness, ...(sessionId ? { sessionId } : {}) };
  }
  const restored = new HarnessError(details, agent);
  if ("stack" in error && typeof error.stack === "string") restored.stack = error.stack;
  if ("cause" in error) restored.cause = error.cause;
  return restored;
}
