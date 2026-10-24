/**
 * @spec Adapters derive optional stable source affinity from parsed facts without I/O or resource creation.
 * @link docs/personal/topic.md#topickey-能力
 */
export interface TopicKeyProvider<T> {
  topicKey(input: T): string | undefined;
}

/** A shared provider keeps user observation and bot intake in the same Lark namespace. */
export const larkTopicKeys: TopicKeyProvider<{ appId: string; chatId: string; threadId?: string; direct?: boolean }> = {
  topicKey({ appId, chatId, threadId, direct }) {
    if (!appId || !chatId) throw new Error("Lark topic key requires appId and chatId");
    return `lark:${appId}:${chatId}${!direct && threadId ? `:thread:${threadId}` : ""}`;
  },
};
