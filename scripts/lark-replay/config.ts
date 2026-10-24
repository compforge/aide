import { z } from "zod";

export const settleMs = 2200;

/** @spec CLI and programmatic replay budgets must leave time for processing plus quiet confirmation.
 * @link docs/e2e-lark-replay.md
 * @case tests/lark-replay.test.ts
 */
export const ReplayTimeoutSchema = z.coerce.number().int().min(5000).max(3_600_000).default(180_000);
