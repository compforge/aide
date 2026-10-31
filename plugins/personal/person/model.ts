import { PersonDeliverySchema } from "./delivery.ts";
import { KeyedSet } from "@compforge/ts-stdx/collections";
import { SensitivitySchema } from "../disclosure.ts";
import type { ResourceContext } from "../context.ts";
import { z } from "zod";
import type { Resource } from "@compforge/aide-plugin";

export const PERSON_TYPE = { apiVersion: "aide.dev/v1alpha3", kind: "Person" } as const;
export const IdentitySchema = z.object({ provider: z.string().trim().min(1), scope: z.string().trim().min(1), id: z.string().trim().min(1) }).strict()
  .superRefine((identity, ctx) => {
    if (identity.provider !== "lark") return;
    if (!/^cli_[a-zA-Z0-9]+$/.test(identity.scope)) ctx.addIssue({ code: "custom", path: ["scope"], message: "Lark identity scope must be an appId" });
    if (!/^ou_[a-zA-Z0-9]+$/.test(identity.id)) ctx.addIssue({ code: "custom", path: ["id"], message: "Lark identity must use open_id" });
  });
export type PersonIdentity = z.infer<typeof IdentitySchema>;
export const identityKey = (identity: PersonIdentity) => JSON.stringify([identity.provider, identity.scope, identity.id]);
export const IdentitiesSchema = z.array(IdentitySchema).max(100).refine((items) => new Set(items.map(identityKey)).size === items.length, "Duplicate Person identity");
/** Me marks are independent of execution credentials and never inferred from a profile. */
export interface Me { readonly identities: readonly PersonIdentity[] }
export const LOCAL_ME: PersonIdentity = { provider: "web", scope: "local", id: "me" };
export const PersonSchema = z.object({ name: z.string().trim().min(1).max(200), identities: IdentitiesSchema.default([]), clearance: SensitivitySchema.default("L1"), delivery: PersonDeliverySchema.optional() }).strict();
export type Person = Omit<z.infer<typeof PersonSchema>, "clearance"> & { clearance?: import("../disclosure.ts").Sensitivity };
/** A historical reference pins an incarnation; it does not require the Person to remain alive. */
export const PersonRefSchema = z.object({ apiVersion: z.string().min(1), kind: z.literal("Person"),
  namespace: z.literal("v1"), name: z.string().min(1), uid: z.string().min(1) }).strict();
export type PersonRef = z.infer<typeof PersonRefSchema>;
export interface PersonStatus extends ResourceContext { updatedAt: string; updatedBy: "user" | "chief" | "connector" }
export type PersonResource = Resource<Person, PersonStatus>;
export const personRef = (person: Readonly<PersonResource>): PersonRef => ({ ...PERSON_TYPE,
  namespace: "v1", name: person.metadata.name, uid: person.metadata.uid });
export const isMe = (person: Pick<Person, "identities">, me: Me) => person.identities.some((i) => me.identities.some((mark) => identityKey(i) === identityKey(mark)));

/** @spec people and receivers are Person UID sets: order and duplicate entries carry no meaning.
 * @link docs/personal/disclosure.md
 * @case tests/output-disclosure.test.ts
 */
export type PersonRefs = KeyedSet<PersonRef>;
/** Canonical UID order makes storage and fingerprints independent of insertion order. */
export const personRefs = (people: Iterable<PersonRef>): PersonRefs =>
  new KeyedSet(person => person.uid, [...people].sort((a, b) => a.uid < b.uid ? -1 : a.uid > b.uid ? 1 : 0));
export const PersonRefsSchema = (max?: number) => z.preprocess(value => value instanceof KeyedSet ? [...value] : value,
  (max === undefined ? z.array(PersonRefSchema) : z.array(PersonRefSchema).max(max)).transform(personRefs));
