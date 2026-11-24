/** Stable marker used to associate native queue delivery with its Host admission. */
export const inputDeliveryMarker = (messageId: string): string => `[aide-input:${messageId}]`;

/** Extract only the host prefix of a user message; quoted material may contain other markers. */
export function deliveredMessageId(content: unknown): string | undefined {
  const text = typeof content === "string" ? content : Array.isArray(content) && content.find(part => part?.type === "text")?.text;
  return typeof text === "string" ? /^\[aide-input:([^\]\n]+)\]\n/.exec(text)?.[1] : undefined;
}
