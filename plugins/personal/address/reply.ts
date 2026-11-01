import type { Resource } from "@compforge/aide-plugin";
import type { InputSpec, InputStatus } from "../input/model.ts";
import { z } from "zod";
const Evidence = z.object({ provider: z.literal("lark"), accountId: z.string(), chatId: z.string().optional(), kind: z.string().optional(),
  originalMessageId: z.string().optional(), messageId: z.string().optional(),
  message: z.object({ id: z.string(), chatId: z.string(), deleted: z.boolean().optional(), parentId: z.string().optional() }).optional() });
/** @spec Source and Channel intake share the external message identity, independently of Topic or execution. */
export function replyIdentity(input: Resource<InputSpec, InputStatus>) {
  const parsed = Evidence.safeParse(input.spec.observation);
  if (!parsed.success) return;
  const e = parsed.data, messageId = e.originalMessageId ?? e.messageId ?? e.message?.id
    ?? (input.spec.origin === "channel" ? input.metadata.name : undefined);
  const chatId = e.chatId ?? e.message?.chatId;
  if (!messageId || !chatId) return;
  return { key: JSON.stringify(["lark", e.accountId, chatId, messageId]), messageId,
    mentionMe: input.spec.origin === "source" && e.kind === "mention", deleted: e.message?.deleted === true };
}

export function obsoleteReplies(input: InputSpec): string[] {
  const evidence = input.observation as { provider?: string; accountId?: string; chatId?: string;
    message?: { id?: string; chatId?: string; parentId?: string; deleted?: boolean; relation?: string };
    context?: { messages?: Array<{ id?: string; chatId?: string; parentId?: string; deleted?: boolean; relation?: string }> } } | undefined;
  if (evidence?.provider !== "lark" || !evidence.accountId) return [];
  const messages = [...(evidence.message ? [{ ...evidence.message, relation: evidence.message.relation ?? input.relation }] : []), ...evidence.context?.messages ?? []];
  return messages.flatMap(message => {
    const id = message.deleted ? message.id : message.relation === "sent" ? message.parentId : undefined;
    const chatId = message.chatId ?? evidence.chatId;
    return id && chatId ? [JSON.stringify(["lark", evidence.accountId, chatId, id])] : [];
  });
}
