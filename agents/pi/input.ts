/** Stable marker used to associate native queue delivery with its Host admission. */
export const inputDeliveryMarker = (messageId: string): string => `[aide-input:${messageId}]`;

/** Native deliveries carry structured identity. Legacy user entries use only the host prefix. */
export function deliveredMessageId(message: unknown, customType = "aide.input"): string | undefined {
  if (!message || typeof message !== "object") return;
  if ("customType" in message && message.customType === customType && "details" in message) {
    const details = message.details;
    if (details && typeof details === "object" && "deliveryId" in details && typeof details.deliveryId === "string") return details.deliveryId;
    return;
  }
  if (!("role" in message) || message.role !== "user" || !("content" in message)) return;
  const content = message.content;
  const text = typeof content === "string" ? content : Array.isArray(content) && content.find(part => part?.type === "text")?.text;
  return typeof text === "string" ? /^\[aide-input:([^\]\n]+)\]\n/.exec(text)?.[1] : undefined;
}
