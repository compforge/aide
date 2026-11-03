import { createHash } from "node:crypto";
import type { InputSpec } from "./model.ts";

/** @spec Producers own event identity; intake only compares opaque keys and derives a resource name.
 * @case tests/input-message-identity.test.ts
 * @link docs/personal/input.md#输入事件身份
 */
export function inputIdentity(spec: Pick<InputSpec, "inputKey">) {
  if (spec.inputKey === undefined) return;
  if (typeof spec.inputKey !== "string" || !spec.inputKey.length || spec.inputKey.length > 2000) throw new Error("inputKey must contain 1–2000 characters");
  return { key: spec.inputKey, name: createHash("sha256").update(spec.inputKey).digest("hex") };
}

/** @spec Channel admission may supplement the same Source event while preserving all processing receipts. */
export function channelPromotion(previous: Pick<InputSpec, "origin" | "inputKey">, next: Pick<InputSpec, "origin" | "inputKey">): boolean {
  return previous.origin === "source" && next.origin === "channel" && !!previous.inputKey && previous.inputKey === next.inputKey;
}
