import type { Address as Endpoint } from "@compforge/aide-plugin";
import { larkEndpoint, larkThreadAddress } from "../../../src/channel/address.ts";
import type { AddressResource } from "./model.ts";

/** @spec Prefer the explicit Lark chat coordinate; open_id can reach a newly discovered DM before its chat is observed. */
export function deliveryEndpoint(address: AddressResource, replyToMessageId?: string): Endpoint {
  const values = [...address.spec.locators];
  const selected = values.find(value => larkEndpoint(value)?.receiveIdType === "chat_id") ?? values[0]!;
  const lark = larkEndpoint(selected);
  return replyToMessageId && lark?.receiveIdType === "chat_id" ? larkThreadAddress(lark.appId, lark.receiveId, replyToMessageId) : selected;
}
