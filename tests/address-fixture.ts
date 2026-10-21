import type { ChannelAddress } from "@compforge/aide-plugin";
import { larkAddress, webAddress } from "../src/channel/address.ts";

/** Legacy fixture IDs encode their intended transport; production never uses this decoder. */
export function fixtureAddress(id: string): ChannelAddress {
  const match = /^lark:([^:]+):(.+)$/.exec(id);
  return match ? larkAddress(match[1]!, match[2]!) : webAddress(id);
}
export function fixtureIncoming<T extends { channelId?: string; sessionId: string }>(input: T): T & { source: ChannelAddress } {
  return { source: input.channelId === "web" ? webAddress(input.sessionId) : fixtureAddress(input.sessionId), ...input };
}
