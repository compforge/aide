import { z } from "zod";
import type { TopicLocator } from "../../plugins/personal/topic/locator.ts";
import type { Address, ChannelAddress } from "@compforge/aide-plugin";

export function isChannelAddress(address: Address): address is ChannelAddress {
  const value = address as Partial<ChannelAddress>;
  return value.kind === "channel" && typeof value.channelId === "string" && typeof value.endpoint === "string";
}
export function webAddress(topicId: string): ChannelAddress {
  if (!topicId) throw new Error("Web address requires a topic endpoint");
  return { kind: "channel", channelId: "web", endpoint: topicId };
}
export function larkAddress(appId: string, chatId: string): ChannelAddress {
  if (!appId || !chatId) throw new Error("Lark address requires appId and chatId");
  return { kind: "channel", channelId: "lark", endpoint: [appId, chatId].map(encodeURIComponent).join("/") };
}
/** Reply to a message inside its existing Lark thread; chat identity remains explicit. */
export function larkThreadAddress(appId: string, chatId: string, messageId: string): ChannelAddress {
  if (!appId || !chatId || !messageId) throw new Error("Lark thread address requires app, chat and message IDs");
  return { kind: "channel", channelId: "lark", endpoint: [appId, chatId, "thread", messageId].map(encodeURIComponent).join("/") };
}
/** A shared locator keeps user observation and bot intake in the same Lark namespace. */
export const larkTopicLocator = {
  locate({ appId, chatId, threadId, direct }) {
    if (!appId || !chatId) throw new Error("Lark topic key requires appId and chatId");
    return { kind: "key" as const, key: `lark:${appId}:${chatId}${!direct && threadId ? `:thread:${threadId}` : ""}` };
  },
} satisfies TopicLocator<{ appId: string; chatId: string; threadId?: string; direct?: boolean }>;

/**
 * @spec Lark topics share app/chat identity across Channel and Source; group threads have their own Topic.
 * @link docs/connector/lark-messages.md#topic-创建与归属
 */
export function larkTopicKey(appId: string, chatId: string, threadId?: string): string {
  return larkTopicLocator.locate({ appId, chatId, threadId }).key;
}
export function larkPersonAddress(appId: string, openId: string): ChannelAddress {
  if (!appId || !openId) throw new Error("Lark person address requires appId and openId");
  return { kind: "channel", channelId: "lark", endpoint: [appId, "open_id", openId].map(encodeURIComponent).join("/") };
}
export function larkEndpoint(address: Address): { appId: string; receiveId: string; receiveIdType: "chat_id" | "open_id"; replyToMessageId?: string } | undefined {
  if (!isChannelAddress(address) || address.channelId !== "lark") return;
  const parts = address.endpoint.split("/");
  if (parts.length === 4 && parts[2] === "thread" && parts.every(Boolean)) {
    const [appId, chatId, , messageId] = parts.map(decodeURIComponent) as [string, string, string, string];
    if (larkThreadAddress(appId, chatId, messageId).endpoint !== address.endpoint) throw new Error("Lark address endpoint must use canonical encoding");
    return { appId, receiveId: chatId, receiveIdType: "chat_id", replyToMessageId: messageId };
  }
  if (parts.some(p => !p) || (parts.length !== 2 && (parts.length !== 3 || parts[1] !== "open_id"))) throw new Error("Invalid Lark address endpoint");
  const decoded = parts.map(decodeURIComponent), appId = decoded[0]!, receiveId = decoded.at(-1)!;
  const receiveIdType = parts.length === 2 ? "chat_id" : "open_id";
  const canonical = receiveIdType === "chat_id" ? larkAddress(appId, receiveId) : larkPersonAddress(appId, receiveId);
  if (canonical.endpoint !== address.endpoint) throw new Error("Lark address endpoint must use canonical encoding");
  return { appId, receiveId, receiveIdType };
}
/** @spec Observing an address through a Connector does not configure a Channel to send to it. */
export function assertChannelDelivery(address: Address, larkAppIds: readonly string[] = []): void {
  if (!isChannelAddress(address)) return; // Connector destinations have their own delivery preflight.
  if (address.channelId === "web") return;
  const endpoint = larkEndpoint(address);
  if (!endpoint || !larkAppIds.includes(endpoint.appId)) {
    throw new Error(`No configured Channel can deliver to ${JSON.stringify(address)}. ${larkAppIds.length ? `Enabled Lark apps: ${larkAppIds.join(", ")}.` : "Lark Channel is disabled."} Use a known Channel address; do not substitute app IDs in Connector addresses.`);
  }
}
export const ChannelAddressSchema = z.object({ kind: z.literal("channel"), channelId: z.string().min(1), endpoint: z.string().min(1).max(2000) }).strict().superRefine((address, ctx) => {
  try {
    if (address.channelId === "lark") larkEndpoint(address);
    else if (address.channelId !== "web") throw new Error(`Unsupported Channel address: ${address.channelId}`);
  } catch (error) { ctx.addIssue({ code: "custom", message: String(error) }); }
});
