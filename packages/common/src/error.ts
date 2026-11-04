/** Public diagnostics only; never copy SDK request bodies, credentials or raw response text. */
export interface AideErrorOptions {
  readonly retryable: boolean;
  readonly code: string;
  readonly biz_code?: string;
  readonly message: string;
}

/** @spec retryable describes recovery potential, not permission to replay an uncertain side effect.
 * @link docs/errors.md
 */
export class AideError extends Error {
  override readonly name: string = "AideError";
  readonly retryable: boolean;
  readonly code: string;
  readonly biz_code?: string;
  constructor(options: AideErrorOptions) {
    super(options.message);
    this.retryable = options.retryable;
    this.code = options.code;
    this.biz_code = options.biz_code;
  }
}

/** @spec Recognize the wire contract across SDK copies without relying on class identity.
 * @case tests/aide-error.test.ts
 */
export function aideErrorDetails(error: unknown): AideErrorOptions | undefined {
  if (!error || typeof error !== "object") return;
  if (!("retryable" in error) || typeof error.retryable !== "boolean" ||
      !("code" in error) || typeof error.code !== "string" || !error.code || error.code.length > 200 ||
      !("message" in error) || typeof error.message !== "string" || !error.message || error.message.length > 4000) return;
  const biz_code = "biz_code" in error ? error.biz_code : undefined;
  if (biz_code !== undefined && (typeof biz_code !== "string" || !biz_code || biz_code.length > 200)) return;
  return { retryable: error.retryable, code: error.code, message: error.message,
    ...(biz_code !== undefined ? { biz_code } : {}) };
}
