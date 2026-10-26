import { z } from "zod";

const Message = z.object({ id: z.string(), chatId: z.string(), createdAt: z.string(), content: z.string(),
  sender: z.object({ id: z.string(), type: z.string(), name: z.string().optional() }),
  mentions: z.array(z.string()), parentId: z.string().optional(), relation: z.enum(["sent", "received", "observed"]).optional(),
});
const Observation = z.object({ provider: z.literal("lark"), accountId: z.string(), userId: z.string(),
  kind: z.enum(["direct", "mention", "sent", "discussion"]), message: Message,
  context: z.object({ messages: z.array(Message) }).optional(),
});

/**
 * @spec Preview only the trigger or follow-up messages, preserving each author and relation beside their words.
 * @why Identity must survive compact input context without replacing original text or expanding surrounding history.
 * @link docs/kernel.md#输入关系与交流对象
 * @case tests/message-source.test.ts
 */
export function messagePreview(observation: Record<string, unknown> | undefined): string | undefined {
  const parsed = Observation.safeParse(observation);
  if (!parsed.success) return undefined;
  const { accountId, userId, kind, message, context } = parsed.data;
  const messages = kind === "discussion" ? context?.messages : [message];
  if (!messages?.length) return undefined;
  return `Observed Lark conversation; this observation is not itself a direct request to Aide.\n${JSON.stringify({
    provider: "lark", scope: accountId, observerId: userId, chatId: message.chatId, kind,
  })}\nMentions and reply references are evidence; unlisted recipients are unknown.\n\n`
    + messages.map(item => `${JSON.stringify({ messageId: item.id, at: item.createdAt, author: item.sender,
      relationToMe: item.relation ?? "unknown", mentions: item.mentions,
      ...(item.parentId ? { replyToMessageId: item.parentId } : {}),
    })}\n${item.content}`).join("\n\n");
}
