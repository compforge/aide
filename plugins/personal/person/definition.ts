import { validateSummary } from "../note/summary.ts";
import { guardContext } from "../context-write.ts";
import { ContextFields } from "../context.ts";
import { z } from "zod";
import type { ResourceDefinition, ResourceValidationContext, Resource } from "@compforge/aide-plugin";
import { PersonSchema, PERSON_TYPE, identityKey, type Person, type PersonStatus } from "./model.ts";

/** @spec Account ownership is unique; Me consolidation can transfer identities atomically between Persons.
 * @why Only newly claimed identities need indexed conflict checks; profile updates do not rescan the catalog.
 * @case tests/resource-validation-scope.test.ts
 * @link docs/personal/person.md#身份me-与关系
 */
function validate(resource: Readonly<Resource<Person, PersonStatus>>, context: ResourceValidationContext, previous?: Readonly<Resource<Person, PersonStatus>>) {
  if (resource.metadata.namespace !== "v1") throw new Error("Person requires the shared v1 namespace");
  const retained = new Set(previous?.spec.identities.map(identityKey));
  for (const key of resource.spec.identities.map(identityKey)) {
    if (retained.has(key)) continue;
    const owners = context.list<Person, PersonStatus>(PERSON_TYPE, { matchIndex: { name: "identity", value: key } });
    if (owners.some(p => p.metadata.uid !== resource.metadata.uid)) throw new Error("Person identity already belongs to another Person");
  }
}
export const PersonDefinition: ResourceDefinition<Person, PersonStatus> = { type: PERSON_TYPE,
  schema: { spec: PersonSchema, status: z.object({ ...ContextFields, updatedAt: z.string(), updatedBy: z.enum(["user", "chief", "connector"]) }).strict() },
  retention: { releasedAt: () => undefined, references: () => [] },
  indexes: { identity: r => r.metadata.deletionTimestamp ? [] : r.spec.identities.map(identityKey) },
  validator: { create: (r, c) => { validateSummary(r, c); validate(r, c); }, update: (previous, resource, context) => { guardContext(previous, resource, context); validate(resource, context, previous); } },
  printer: { describe: r => `${r.spec.name}\n${JSON.stringify({ ...r.spec, summaryRevision: r.status.summaryRevision }, null, 2)}`, summarize: r => r.spec.name },
};
