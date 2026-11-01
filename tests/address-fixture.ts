import { Addresses } from "../plugins/personal/address/service.ts";
import { addressRef } from "../plugins/personal/address/model.ts";
import type { ChannelAddress } from "@compforge/aide-plugin";
import { larkAddress, webAddress } from "../src/channel/address.ts";

/** Legacy fixture IDs encode their intended transport; production never uses this decoder. */
export function fixtureAddress(id: string): ChannelAddress {
  const match = /^lark:([^:]+):(.+)$/.exec(id);
  return match ? larkAddress(match[1]!, match[2]!) : webAddress(id);
}
export function fixtureIncoming<T extends { channelId?: string; topicId: string }>(input: T): T & { source: ChannelAddress } {
  return { source: input.channelId === "web" ? webAddress(input.topicId) : fixtureAddress(input.topicId), ...input };
}

/** Explicit permission for tests that exercise transport after policy checking. */
export function allowAddress(home: string, target: import("../plugins/personal/address/service.ts").AddressTarget) {
  const addresses = new Addresses(home), address = addresses.observe(target);
  if (address.spec.muted) addresses.setMuted(addressRef(address), false, true);
}
