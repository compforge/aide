/** Stable marker used to associate native queue delivery with its Host admission. */
export const inputDeliveryMarker = (messageId: string): string => `[aide-input:${messageId}]`;
