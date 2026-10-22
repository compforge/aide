import type { Address } from "@compforge/aide-plugin";
import { z } from "zod";
import { RequirementAddressSchema } from "../connectors/requirements/address.ts";
import { ChannelAddressSchema } from "./channel/address.ts";

/** @spec Only installed address kinds can be admitted for delivery. Add dispatch here with a new address implementation. */
export const AddressSchema = z.union([ChannelAddressSchema, RequirementAddressSchema]);
export function parseAddress(value: unknown): Address { return AddressSchema.parse(value); }
export function sameAddress(a: Address, b: Address): boolean {
  const left = AddressSchema.parse(a), right = AddressSchema.parse(b);
  if (left.kind === "channel" && right.kind === "channel") return left.channelId === right.channelId && left.endpoint === right.endpoint;
  if (left.kind === "requirement" && right.kind === "requirement") return left.source === right.source && left.scope === right.scope && left.category === right.category && left.id === right.id;
  return false;
}
