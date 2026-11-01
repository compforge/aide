import { z } from "zod";
import { ContextFields } from "../context.ts";
import { PersonRefsSchema } from "../person/model.ts";
import type { ResourceDefinition, ResourceValidationContext } from "@compforge/aide-plugin";
import { equalResourceValue } from "../../../src/resource/value.ts";
import { guardContext } from "../context-write.ts";
import { validateSummary } from "../note/summary.ts";
import { ADDRESS_TYPE, AddressSpecSchema, type AddressSpec, type AddressStatus } from "./model.ts";

/** @spec New participant observations must pin a live Person; stale observations cannot refill a completed merge migration. */
function validatePeople(after: AddressStatus, context: ResourceValidationContext, before?: AddressStatus) {
  const existing = new Set([...(before?.people ?? [])].map(ref => ref.uid));
  for (const ref of after.people) {
    if (existing.has(ref.uid)) continue;
    const person = context.get(ref, ref.uid);
    if (!person || person.metadata.deletionTimestamp || person.metadata.name !== ref.name || person.metadata.namespace !== ref.namespace)
      throw new Error("Address participant no longer exists; resolve the current Person before observing");
  }
}

export const AddressDefinition: ResourceDefinition<AddressSpec, AddressStatus> = {
  type: ADDRESS_TYPE, schema: { spec: AddressSpecSchema, status: z.object({ ...ContextFields, people: PersonRefsSchema().prefault([]) }).strict() },
  indexes: { uid: r => [r.metadata.uid], endpoint: r => [JSON.stringify(r.spec.endpoint)], people: r => [...r.status.people].map(p => p.uid) },
  validator: { create(r, context) {
    if (r.metadata.namespace !== "v1" || r.metadata.owner) throw new Error("Address requires an independent shared identity");
    if (context.page(ADDRESS_TYPE, { limit: 2, matchIndex: { name: "endpoint", value: JSON.stringify(r.spec.endpoint) } }).items.some(a => a.metadata.uid !== r.metadata.uid))
      throw new Error("Address endpoint already exists");
    validatePeople(r.status, context);
    validateSummary(r, context);
  }, update(before, after, context) {
    if (!equalResourceValue(before.spec.endpoint, after.spec.endpoint)) throw new Error("Address endpoint is immutable");
    validatePeople(after.status, context, before.status);
    guardContext(before, after, context);
  } },
  retention: { releasedAt: () => undefined, references: () => [] },
  printer: { summarize: r => `${r.spec.name}${r.spec.muted ? " (muted)" : ""}`, describe: r => JSON.stringify(r, null, 2) },
};
