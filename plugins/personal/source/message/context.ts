import type { ChatMessage, MessageConnector, PluginLogger } from "@compforge/aide-plugin";
import type { MessageWatch } from "./config.ts";

export interface MessageContext {
  messages: ChatMessage[];
  observedThrough: string;
  truncated: boolean;
  missingRoot?: boolean;
}
const iso = (ms: number) => new Date(ms).toISOString();

/** Keep the query boundary explicit even when the context must be shortened for a model. */
export function boundContext(messages: ChatMessage[], observedThrough: string, truncated: boolean, maxChars: number): MessageContext {
  let remaining = maxChars;
  const bounded: ChatMessage[] = [];
  for (const [index, message] of messages.entries()) {
    if (remaining <= 0) { truncated = true; break; }
    const content = message.content.slice(0, Math.floor(remaining / (messages.length - index)));
    truncated ||= content.length < message.content.length;
    bounded.push({ ...message, content });
    remaining -= content.length;
  }
  return { messages: bounded, observedThrough, truncated };
}

/**
 * @spec Context reads are bounded observations, not a claim that the complete topic was retrieved.
 * @why Thread previews in group history are incomplete; explicit thread reads preserve that boundary.
 * @link docs/connector/lark-messages.md
 */
export async function readMessageContext(connector: MessageConnector, anchor: ChatMessage, watch: MessageWatch, now: number, logger: PluginLogger): Promise<MessageContext> {
  const at = Date.parse(anchor.createdAt);
  const end = Math.min(now, at + watch.contextWindowMs);
  const before = anchor.threadId
    ? await connector.thread({ threadId: anchor.threadId, order: "asc", limit: watch.beforeMessages })
    : await connector.history({ chatId: anchor.chatId, start: iso(at - watch.contextWindowMs),
      end: iso(Math.min(now, at + 60_000)), order: "desc", limit: watch.beforeMessages + 1 });
  const after = anchor.threadId
    ? await connector.thread({ threadId: anchor.threadId, order: "desc", limit: watch.afterMessages })
    : await connector.history({ chatId: anchor.chatId, start: iso(at), end: iso(end),
      order: "asc", limit: watch.afterMessages + 1 });
  let roots: ChatMessage[] = [];
  if (anchor.threadId && anchor.threadPosition !== "-1") {
    try {
      const history = await connector.history({ chatId: anchor.chatId, start: iso(at - watch.contextWindowMs),
        end: iso(Math.min(now, at + 60_000)), order: "desc", limit: 50 });
      roots = history.messages.filter((message) => message.threadId === anchor.threadId && message.threadPosition === "-1");
    } catch (error) {
      logger.warn("Lark thread root unavailable; keeping retrieved context", { attributes: {
        messageId: anchor.id, chatId: anchor.chatId, threadId: anchor.threadId,
        error: error instanceof Error ? error.message : String(error) } });
    }
  }
  const missingRoot = Boolean(anchor.threadId && anchor.threadPosition !== "-1" && !roots.length);
  const rows = [...new Map([...roots, ...before.messages, ...after.messages].map((message) => [message.id, message])).values()]
    .filter((message) => message.id !== anchor.id && !message.deleted)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  return { ...boundContext(rows, iso(anchor.threadId ? now : end), before.hasMore || after.hasMore || missingRoot, watch.maxContextChars),
    ...(anchor.threadId ? { missingRoot } : {}) };
}
