import { z } from "zod";
import type { Address, ChannelAddress } from "@compforge/aide-plugin";

export function isChannelAddress(address: Address): address is ChannelAddress {
  const value = address as Partial<ChannelAddress>;
  return value.kind === "channel" && typeof value.channelId === "string" && typeof value.endpoint === "string";
}
export function webAddress(conversationId: string): ChannelAddress {
  if (!conversationId) throw new Error("Web address requires a conversation endpoint");
  return { kind: "channel", channelId: "web", endpoint: conversationId };
}
export function larkAddress(appId: string, chatId: string): ChannelAddress {
  if (!appId || !chatId) throw new Error("Lark address requires appId and chatId");
  return { kind: "channel", channelId: "lark", endpoint: [appId, chatId].map(encodeURIComponent).join("/") };
}
export function larkEndpoint(address: Address): { appId: string; chatId: string } | undefined {
  if (!isChannelAddress(address) || address.channelId !== "lark") return;
  const parts = address.endpoint.split("/");
  if (parts.length !== 2 || parts.some((p) => !p)) throw new Error("Invalid Lark address endpoint");
  const [appId, chatId] = parts.map(decodeURIComponent);
  if (larkAddress(appId!, chatId!).endpoint !== address.endpoint) throw new Error("Lark address endpoint must use canonical encoding");
  return { appId: appId!, chatId: chatId! };
}
export const ChannelAddressSchema = z.object({ kind: z.literal("channel"), channelId: z.string().min(1), endpoint: z.string().min(1).max(2000) }).strict().superRefine((address, ctx) => {
  try {
    if (address.channelId === "lark") larkEndpoint(address);
    else if (address.channelId !== "web") throw new Error(`Unsupported Channel address: ${address.channelId}`);
  } catch (error) { ctx.addIssue({ code: "custom", message: String(error) }); }
});
