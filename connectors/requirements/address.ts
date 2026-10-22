import { z } from "zod";
import type { Address, RequirementAddress, RequirementIdentity } from "@compforge/aide-plugin";
export const RequirementAddressSchema = z.object({ kind: z.literal("requirement"), source: z.string().min(1),
  category: z.string().min(1), id: z.string().min(1), scope: z.string().min(1) }).strict();
export function isRequirementAddress(address: Address): address is RequirementAddress { return address.kind === "requirement"; }
export function requirementAddress(identity: RequirementIdentity, scope: string): RequirementAddress {
  return { kind: "requirement", source: identity.source, category: identity.category, id: identity.id, scope };
}
