import type { Logger } from "pino";
import type { ResourceClient } from "@compforge/aide-plugin";
import { PluginResourceStore } from "../../../src/host/plugin/resource/store.ts";
import { createResourceClient } from "../../../src/host/plugin/resource/client.ts";
import { scopedResources } from "../../../src/host/plugin/resource/directory.ts";
import { PersonSchema, PERSON_SESSION, PERSON_TYPE, identityKey, isMe, type Me, type Person, type PersonStatus } from "./model.ts";
import { Persons } from "./service.ts";

/** @spec A catalog owns shared Persons without starting a conversation or a Person reconciler. Every writer validates the same identity constraints. */
export function openPersonCatalog(home: string, marks: Me, log: Logger, changed: () => void) {
  // Reuse the plugin resource store with a reserved directory scope, without Session metadata or a Ledger.
  const store = new PluginResourceStore({ session: { id: PERSON_SESSION, dir: home }, pluginInstanceId: "personal" });
  const base = createResourceClient(store, (change) => {
    log.info({ personId: change.resource.metadata.name, version: change.resource.metadata.resourceVersion, action: change.kind }, "Person resource changed");
    changed();
  });
  const validate = (name: string, value: unknown) => {
    const spec = PersonSchema.parse(value);
    const keys = new Set(spec.identities.map(identityKey));
    const others = store.list<Person, PersonStatus>(PERSON_TYPE).filter((p) => p.metadata.name !== name && !p.metadata.deletionTimestamp);
    if (others.some((p) => p.spec.identities.some((i) => keys.has(identityKey(i))))) throw new Error("Person identity already belongs to another Person");
    if (isMe(spec, marks) && others.some((p) => isMe(p.spec, marks))) throw new Error("Me identities must belong to one Person");
    if (name === "me" && marks.identities.some((i) => !keys.has(identityKey(i)))) throw new Error("A configured Me identity cannot be removed; change the Me configuration first");
    return spec;
  };
  const assertPerson = (type: { apiVersion: string; kind: string }, namespace = "v1") => { if (type.kind !== PERSON_TYPE.kind || type.apiVersion !== PERSON_TYPE.apiVersion || namespace !== "v1") throw new Error("Person catalog only accepts Person resources"); };
  const guarded: ResourceClient = { ...base,
    async create(type, init) { assertPerson(type, init.namespace); const spec = validate(init.name, init.spec); return base.create(type, { ...init, spec: spec as typeof init.spec }); },
    async replace(resource, spec, status) { assertPerson(resource, resource.metadata.namespace); const parsed = validate(resource.metadata.name, spec); return base.replace(resource, parsed as typeof spec, status); },
    async delete() { throw new Error("Person deletion is not supported; edit its profile or identities"); },
  };
  const client = scopedResources(guarded, PERSON_SESSION, "personal");
  return { client, persons: new Persons(client, marks) };
}
