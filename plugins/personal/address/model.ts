import { KeyedSet } from "@compforge/ts-stdx/collections";
import type { Resource } from "@compforge/aide-plugin";
import { z } from "zod";
import { AddressSchema } from "../../../src/address.ts";
import type { ResourceContext } from "../context.ts";

export const ADDRESS_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Address" } as const;
export const AddressRefSchema = z.object({ apiVersion: z.literal(ADDRESS_TYPE.apiVersion), kind: z.literal("Address"),
  namespace: z.literal("v1"), name: z.string().min(1), uid: z.string().min(1) }).strict();
export type AddressRef = z.infer<typeof AddressRefSchema>;
export type AddressRefs = KeyedSet<AddressRef>;
export const addressRefs = (refs: Iterable<AddressRef>) => new KeyedSet((r: AddressRef) => r.uid,
  [...refs].sort((a, b) => a.uid.localeCompare(b.uid)));
export const AddressRefsSchema = z.preprocess(value => value instanceof KeyedSet ? [...value] : value,
  z.array(AddressRefSchema).transform(addressRefs));
export const AddressSpecSchema = z.object({ name: z.string().trim().min(1).max(200),
  endpoint: AddressSchema, aliases: z.array(AddressSchema).max(1).default([]), type: z.enum(["group", "direct", "web", "external"]), muted: z.boolean().default(true) }).strict();
/** @spec people are accumulated known participants, not a complete or current platform membership claim.
 * @link docs/personal/address.md
 */

export type AddressSpec = z.infer<typeof AddressSpecSchema>;
export interface AddressStatus extends ResourceContext { people: import("../person/model.ts").PersonRefs }
export type AddressResource = Resource<AddressSpec, AddressStatus>;
export const addressRef = (r: AddressResource): AddressRef => ({ ...ADDRESS_TYPE, namespace: "v1", name: r.metadata.name, uid: r.metadata.uid });
