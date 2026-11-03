/** @spec The same platform message shares its event key across Channels, Sources and observing accounts.
 * @why Account/app identity describes the observer, not the sending event.
 */
export const larkInputKey = (chatId: string, messageId: string): string => JSON.stringify(["lark", "message", chatId, messageId]);
