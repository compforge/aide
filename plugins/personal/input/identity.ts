import { createHash } from "node:crypto";
import { z } from "zod";
import type { InputSpec } from "./model.ts";

const Evidence = z.object({ provider: z.literal("lark"), kind: z.string().optional(),
  chatId: z.string().min(1).optional(), messageId: z.string().min(1).optional(),
  message: z.object({ id: z.string().min(1), chatId: z.string().min(1) }).optional() });

/** @spec One Lark message has one Input across Channels, apps and observing accounts.
 * @why App-scoped open_ids identify people; the platform chat/message coordinates identify this sending event.
 * @spec Discussion batches contain new events; their anchor message does not identify the batch.
 * @case tests/input-message-identity.test.ts
 * @link docs/personal/input.md#平台消息去重
 */
export function larkInputIdentity(spec: Pick<InputSpec, "origin" | "originId" | "observation">) {
  if (!((spec.origin === "channel" && spec.originId === "lark") || (spec.origin === "source" && spec.originId === "personal.lark"))) return;
  const parsed = Evidence.safeParse(spec.observation);
  if (!parsed.success || parsed.data.kind === "discussion") return;
  const e = parsed.data, chatId = e.chatId ?? e.message?.chatId, messageId = e.messageId ?? e.message?.id;
  if (!chatId || !messageId) return;
  const key = JSON.stringify(["lark", chatId, messageId]);
  return { key, name: createHash("sha256").update(key).digest("hex") };
}

/** @spec A later Channel receipt can promote a Source observation of the same message, preserving all processing receipts. */
export function channelPromotion(previous: Pick<InputSpec, "origin" | "originId" | "observation">, next: Pick<InputSpec, "origin" | "originId" | "observation">): boolean {
  const identity = larkInputIdentity(previous);
  return previous.origin === "source" && next.origin === "channel" && !!identity && identity.key === larkInputIdentity(next)?.key;
}
