export type * from "../../packages/plugin/src/connectors/forge.ts";

export class ForgeRateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = "ForgeRateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

export function isForgeRateLimitError(
  error: unknown,
): error is ForgeRateLimitError {
  return error instanceof ForgeRateLimitError;
}
