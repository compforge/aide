import { ContextFields } from "../context.ts";
import { z } from "zod";
import type { ResourceDefinition, ResourceValidationContext, Resource } from "@compforge/aide-plugin";
import { PersonSchema, PERSON_TYPE, identityKey, type Person, type PersonStatus } from "./model.ts";

/** @spec Account ownership is unique; Me consolidation can transfer identities atomically between Persons.
 * @link docs/personal/person.md#身份me-与关系
 */
function validate(resource: Readonly<Resource<Person, PersonStatus>>, context: ResourceValidationContext) {
  if (resource.metadata.namespace !== "v1") throw new Error("Person requires the shared v1 namespace");
  const keys = new Set(resource.spec.identities.map(identityKey));
  const others = context.list<Person, PersonStatus>(PERSON_TYPE).filter(p => p.metadata.uid !== resource.metadata.uid && !p.metadata.deletionTimestamp);
  if (others.some(p => p.spec.identities.some(i => keys.has(identityKey(i))))) throw new Error("Person identity already belongs to another Person");
}
export const PersonDefinition: ResourceDefinition<Person, PersonStatus> = { type: PERSON_TYPE,
  schema: { spec: PersonSchema, status: z.object({ ...ContextFields, updatedAt: z.string(), updatedBy: z.enum(["user", "chief", "connector"]) }).strict() },
  validator: { create: validate, update: (_old, resource, context) => validate(resource, context) },
  printer: { describe: r => `${r.spec.name}\n${JSON.stringify({ ...r.spec, summary: r.status.summary, recent: r.status.recent }, null, 2)}`, summarize: r => r.spec.name },
};
