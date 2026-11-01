/** A trusted adapter's safe diagnosis; never include request bodies, credentials or raw SDK messages. */
export interface DeliveryFailure {
  /** retryable proves this attempt was rejected before effect; unknown may already have taken effect. */
  kind: "retryable" | "permanent" | "unknown";
  message: string;
  code?: string;
  /** Earliest retry delay in milliseconds. Omit to use the caller's normal backoff. */
  retryAfterMs?: number;
}

/** @spec Adapters own provider-specific errors and rate policy; callers own durable delivery and retry scheduling.
 * @link docs/connector/extensions.md#host-投递错误
 */
export class DeliveryError extends Error {
  override readonly name = "DeliveryError";
  constructor(readonly failure: DeliveryFailure) { super(failure.message); }
}

/** @spec External packages may load another SDK copy; recognize the contract by shape, not class identity. */
export function deliveryFailure(error: unknown): DeliveryFailure | undefined {
  if (!error || typeof error !== "object" || !("name" in error) || error.name !== "DeliveryError" || !("failure" in error)) return;
  const value = error.failure;
  if (!value || typeof value !== "object" || !("kind" in value) || typeof value.kind !== "string" || !["retryable", "permanent", "unknown"].includes(value.kind) ||
      !("message" in value) || typeof value.message !== "string" || !value.message || value.message.length > 4000) return;
  if ("code" in value && (typeof value.code !== "string" || value.code.length > 200)) return;
  if ("retryAfterMs" in value && (typeof value.retryAfterMs !== "number" || !Number.isSafeInteger(value.retryAfterMs) || value.retryAfterMs < 0 || value.retryAfterMs > 2147483647)) return;
  return value as DeliveryFailure;
}
