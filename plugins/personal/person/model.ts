import { z } from "zod";
import type { Resource, ResourceRef } from "@compforge/aide-plugin";

export const PERSON_TYPE = { apiVersion: "aide.dev/v1alpha1", kind: "Person" } as const;
export const PERSON_SESSION = "personal:persons";
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
/** Explicit user corrections stay separate from Chief's synthesis, including removal of old beliefs. */
export const ProfileSchema = z.object({ understanding: z.string().max(12000).default(""), corrections: z.string().max(12000).default("") }).strict();
export const PersonSchema = z.object({ name: z.string().trim().min(1).max(200), identities: IdentitiesSchema.default([]), profile: ProfileSchema.prefault({}) }).strict();
export type Person = z.infer<typeof PersonSchema>;
export interface PersonStatus { updatedAt: string; updatedBy: "user" | "chief" | "connector" }
export type PersonResource = Resource<Person, PersonStatus>;
export const personRef = (person: Readonly<PersonResource>): ResourceRef => ({ ...PERSON_TYPE, sessionId: PERSON_SESSION,
  namespace: person.metadata.namespace, name: person.metadata.name, uid: person.metadata.uid });
export const isMe = (person: Pick<Person, "identities">, me: Me) => person.identities.some((i) => me.identities.some((mark) => identityKey(i) === identityKey(mark)));
