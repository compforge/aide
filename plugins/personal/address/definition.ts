import { larkEndpoint } from "../../../src/channel/address.ts";
import { z } from "zod";
import { ContextFields } from "../context.ts";
import { PersonRefsSchema } from "../person/model.ts";
import type { ResourceDefinition, ResourceValidationContext } from "@compforge/aide-plugin";
import { equalResourceValue } from "../../../src/resource/value.ts";
import { guardContext } from "../context-write.ts";
import { validateSummary } from "../note/summary.ts";
import { ADDRESS_TYPE, AddressSpecSchema, AddressRefsSchema, type AddressSpec, type AddressStatus } from "./model.ts";

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

function validateLocators(resource: import("./model.ts").AddressResource, context: ResourceValidationContext) {
  const values = [...resource.spec.locators];
  if (values.length > 1) {
    const coordinates = values.map(larkEndpoint);
    if (resource.spec.type !== "direct" || coordinates.some(c => !c || c.replyToMessageId || c.appId !== coordinates[0]?.appId)
      || new Set(coordinates.map(c => c?.receiveIdType)).size !== values.length)
      throw new Error("Multiple locators require a proven Lark direct chat/open_id pair");
  }
  for (const locator of values) {
    if (context.page(ADDRESS_TYPE, { limit: 2, matchIndex: { name: "locator", value: JSON.stringify(locator) } }).items.some(a => a.metadata.uid !== resource.metadata.uid))
      throw new Error("Address locator already exists");
  }
}

export const AddressDefinition: ResourceDefinition<AddressSpec, AddressStatus> = {
  type: ADDRESS_TYPE, schema: { spec: AddressSpecSchema, status: z.object({ ...ContextFields, people: PersonRefsSchema().prefault([]), retiring: z.boolean().optional(), mergeSources: AddressRefsSchema.optional() }).strict() },
  indexes: { uid: r => [r.metadata.uid], locator: r => r.metadata.deletionTimestamp || r.status.retiring ? [] : [...r.spec.locators].map(locator => JSON.stringify(locator)), people: r => [...r.status.people].map(p => p.uid) },
  validator: { create(r, context) {
    if (r.metadata.namespace !== "v1" || r.metadata.owner) throw new Error("Address requires an independent shared identity");
    validateLocators(r, context);
    validatePeople(r.status, context);
    validateSummary(r, context);
  }, update(before, after, context) {
    // A stable Address UID cannot be repurposed to another place; discovery only adds equivalent locators.
    if ([...before.spec.locators].some(locator => !after.spec.locators.has(locator))) throw new Error("Existing Address locators cannot be removed or replaced");
    if (!equalResourceValue(before.spec.locators, after.spec.locators) || before.spec.type !== after.spec.type) validateLocators(after, context);
    validatePeople(after.status, context, before.status);
    guardContext(before, after, context);
  } },
  retention: { releasedAt: () => undefined, references: () => [] },
  printer: { summarize: r => `${r.spec.name}${r.spec.muted ? " (muted)" : ""}`, describe: r => JSON.stringify(r, null, 2) },
};
