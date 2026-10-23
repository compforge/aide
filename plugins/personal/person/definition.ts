import { ContextFields } from "../context.ts";
import { z } from "zod";
import type { ResourceDefinition, ResourceValidationContext, Resource } from "@compforge/aide-plugin";
import { PersonSchema, PERSON_TYPE, identityKey, isMe, type Me, type Person, type PersonStatus } from "./model.ts";

const definitions = new Map<string, ResourceDefinition<Person, PersonStatus>>();

/** @spec Person identity uniqueness is checked inside the same transaction as every write, including commit. */
export function personDefinition(marks: Me): ResourceDefinition<Person, PersonStatus> {
  const key = JSON.stringify(marks.identities.map(identityKey).sort());
  const existing = definitions.get(key);
  if (existing) return existing;
  marks = structuredClone(marks);
  const validate = (resource: Readonly<Resource<Person, PersonStatus>>, context: ResourceValidationContext) => {
    if (resource.metadata.namespace !== "v1") throw new Error("Person requires the shared v1 namespace");
    const spec = resource.spec;
    const keys = new Set(spec.identities.map(identityKey));
    const others = context.list<Person, PersonStatus>(PERSON_TYPE).filter((p) => p.metadata.uid !== resource.metadata.uid && !p.metadata.deletionTimestamp);
    if (others.some((p) => p.spec.identities.some((i) => keys.has(identityKey(i))))) throw new Error("Person identity already belongs to another Person");
    if (isMe(spec, marks) && others.some((p) => isMe(p.spec, marks))) throw new Error("Me identities must belong to one Person");
    if (resource.metadata.name === "me" && marks.identities.some((i) => !keys.has(identityKey(i)))) throw new Error("A configured Me identity cannot be removed; change the Me configuration first");
  };
  const definition: ResourceDefinition<Person, PersonStatus> = { type: PERSON_TYPE,
    schema: { spec: PersonSchema, status: z.object({ ...ContextFields, updatedAt: z.string(), updatedBy: z.enum(["user", "chief", "connector"]) }).strict() },
    validator: { create: validate, update: (_old, resource, context) => validate(resource, context),
      delete() { throw new Error("Person deletion is not supported; edit its profile or identities"); } },
    printer: { describe: (r) => `${r.spec.name}\n${JSON.stringify({ ...r.spec, summary: r.status.summary, recent: r.status.recent }, null, 2)}`, summarize: (r) => r.spec.name },
  };
  definitions.set(key, definition);
  return definition;
}
