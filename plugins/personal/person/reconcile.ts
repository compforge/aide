import type { PluginContext, ResourceCommit } from "@compforge/aide-plugin";
import { ADDRESS_TYPE, type AddressSpec, type AddressStatus } from "../address/model.ts";
import { PERSON_TYPE, personRef, personRefs, type PersonResource } from "./model.ts";
import { equalResourceValue } from "../../../src/resource/value.ts";

/**
 * @spec Identity merge commits first; each round transfers at most 50 Address participant sets to the surviving Person.
 * @why The durable source set survives restarts and follows subsequent merges. Removing refs drains the index without a stale cursor.
 * @case tests/person-merge.test.ts
 * @link docs/personal/person.md#用户合并人物
 */
export async function reconcilePerson(context: Pick<PluginContext, "resources" | "logger">, person: Readonly<PersonResource>) {
  if (person.metadata.deletionTimestamp) return;
  const source = [...(person.status.participantSources ?? [])][0];
  if (!source) return;
  const page = await context.resources.page<AddressSpec, AddressStatus>(ADDRESS_TYPE, { namespace: "v1", limit: 50,
    matchIndex: { name: "people", value: source.uid } });
  const writes: ResourceCommit[] = page.items.map(resource => ({ operation: "patch", resource, patch: { type: "json", value: [
    { op: "test", path: "/status/people", value: resource.status.people },
    { op: "replace", path: "/status/people", value: personRefs([...resource.status.people].map(ref => ref.uid === source.uid ? personRef(person) : ref)) },
  ] } }));
  const remaining = personRefs([...person.status.participantSources!].filter(ref => page.items.length || ref.uid !== source.uid));
  // A concurrent merge/deletion of the survivor invalidates this entire batch, including Address writes.
  writes.unshift({ operation: "patchStatus", resource: person, patch: { participantSources: remaining }, options: { resourceVersion: person.metadata.resourceVersion } });
  await context.resources.commit(writes);
  context.logger.info("Person Address participants transferred", { attributes: { personUid: person.metadata.uid, sourceUid: source.uid, addresses: page.items.length, remainingSources: remaining.size } });
  if (remaining.size) return { requeueAfterMs: 100 };
}

export function registerPersons(context: PluginContext): void {
  context.controllers.register({ resourceType: PERSON_TYPE, watches: [{ resourceType: PERSON_TYPE, handler: {
    create: async () => [], delete: async () => [], update: async ({ oldObject, newObject }) => {
      const before = oldObject as PersonResource, after = newObject as PersonResource;
      return !equalResourceValue(before.status.participantSources, after.status.participantSources)
        ? [{ name: after.metadata.name, namespace: after.metadata.namespace }] : [];
    },
  } }], reconcile: async (execution, person: Readonly<PersonResource>) => {
    if (person.metadata.deletionTimestamp) return;
    const result = await execution.verbs.action("reconcile_person_contacts", { id: person.metadata.name });
    if (result.state !== "success") throw new Error("Person contacts reconcile did not complete");
    // Contact discovery may update spec; use the new version for the merge migration CAS.
    const current = await context.resources.get<PersonResource["spec"], PersonResource["status"]>({ ...PERSON_TYPE, name: person.metadata.name, namespace: person.metadata.namespace });
    if (current && current.metadata.uid === person.metadata.uid) return reconcilePerson(context, current);
  } });
}
