import type { Address } from "@compforge/aide-plugin";
import { ChannelAddressSchema } from "./channel/address.ts";

/** @spec Only installed address kinds can be admitted for delivery. Add dispatch here with a new address implementation. */
export const AddressSchema = ChannelAddressSchema;
export function parseAddress(value: unknown): Address { return AddressSchema.parse(value); }
export function sameAddress(a: Address, b: Address): boolean {
  const left = AddressSchema.parse(a), right = AddressSchema.parse(b);
  return left.kind === right.kind && left.channelId === right.channelId && left.endpoint === right.endpoint;
}
