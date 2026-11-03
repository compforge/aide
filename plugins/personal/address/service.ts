import { equalResourceValue } from "../../../src/resource/value.ts";
import { createHash } from "node:crypto";
import type { Address as Endpoint } from "@compforge/aide-plugin";
import { createResourceClient } from "../../../src/host/plugin/resource/client.ts";
import { PluginResourceStore } from "../../../src/host/plugin/resource/store.ts";
import { ResourceStorage } from "../../../src/host/resource/storage.ts";
import { AddressSchema } from "../../../src/address.ts";
import { isChannelAddress, larkEndpoint, larkAddress } from "../../../src/channel/address.ts";
import { PERSON_TYPE, personRefs, type Person, type PersonStatus, type PersonRef } from "../person/model.ts";
import { summaryReference, summaryText, writeSummary, summaryView } from "../note/summary.ts";
import { contentVersion } from "../context-write.ts";
import { notes, pageNotes } from "../note/query.ts";
import { AddressDefinition } from "./definition.ts";
import { ADDRESS_TYPE, addressRef, AddressRefSchema, type AddressRef, type AddressResource, type AddressSpec, type AddressStatus } from "./model.ts";

export type AddressTarget = AddressRef | Endpoint;
/** Transport reply coordinates never create another communication place. */
export function placeEndpoint(raw: Endpoint): AddressSpec["endpoint"] {
  const endpoint = AddressSchema.parse(raw);
  const lark = larkEndpoint(endpoint);
  return lark?.replyToMessageId ? larkAddress(lark.appId, lark.receiveId) : endpoint;
}
export class Addresses {
  readonly resources: PluginResourceStore;
  readonly client: ReturnType<typeof createResourceClient>;
  constructor(home: string) {
    ResourceStorage.open(home).register("personal", [AddressDefinition]);
    this.resources = new PluginResourceStore({ home, pluginInstanceId: "personal" });
    this.client = createResourceClient(this.resources);
  }
  read(ref: AddressRef): AddressResource {
    const r = this.resources.get<AddressSpec, AddressStatus>(ADDRESS_TYPE, ref.name, "v1");
    if (r.metadata.uid !== ref.uid || r.metadata.deletionTimestamp) throw new Error("Address no longer exists");
    return r;
  }
  find(endpoint: Endpoint): AddressResource | undefined {
    const address = this.resources.page<AddressSpec, AddressStatus>(ADDRESS_TYPE, { namespace: "v1", limit: 1,
      matchIndex: { name: "endpoint", value: JSON.stringify(placeEndpoint(endpoint)) } }).items[0];
    return address?.metadata.deletionTimestamp ? undefined : address;
  }
  canSpeak(endpoint: Endpoint): boolean { const address = this.find(endpoint); return !!address && !address.spec.muted; }
  /** @spec Permission reads neither discover places nor alter participants. All membership reads share one transaction snapshot. */
  audience(ref: AddressRef) {
    return this.resources.storage.transaction(() => {
      const address = this.read(ref);
      const people = [];
      for (const ref of address.status.people) {
        const person = this.resources.find<Person, PersonStatus>(PERSON_TYPE, ref.name, ref.namespace);
        if (!person || person.metadata.uid !== ref.uid || person.metadata.deletionTimestamp)
          return { people, private: false, muted: address.spec.muted, unavailable: "Known Address participant no longer resolves" };
        people.push(person);
      }
      return { people, private: address.spec.type === "direct" || address.spec.type === "web", muted: address.spec.muted };
    });
  }
  endpoint(target: AddressTarget): Endpoint { return target.kind === "Address" ? this.read(AddressRefSchema.parse(target)).spec.endpoint : target; }
  /** @spec Discovery only accumulates facts; it never unmutes a known Address or overwrites its summary.
   * @case tests/address-resource.test.ts
   */
  observe(target: AddressTarget, people: Iterable<PersonRef> = [], options: { name?: string; type?: AddressSpec["type"]; muted?: boolean } = {}): AddressResource {
    return this.resources.storage.transaction(() => {
      const endpoint = target.kind === "Address" ? this.read(AddressRefSchema.parse(target)).spec.endpoint : placeEndpoint(target);
      const name = `address-${createHash("sha256").update(JSON.stringify(endpoint)).digest("hex").slice(0, 32)}`;
      const previous = this.find(endpoint);
      const members = personRefs([...(previous?.status.people ?? []), ...people]);
      if (previous) {
        if (previous.metadata.deletionTimestamp) throw new Error("Address is being deleted");
        const displayName = options.name?.trim().slice(0, 200);
        const spec = { ...previous.spec, ...(displayName ? { name: displayName } : {}), ...(options.type ? { type: options.type } : {}) };
        if (equalResourceValue(previous.spec, spec) && equalResourceValue(previous.status.people, members)) return previous;
        return this.resources.replace(ADDRESS_TYPE, previous.metadata.name, spec, { ...previous.status, people: members });
      }
      const lark = larkEndpoint(endpoint);
      const type = options.type ?? (isChannelAddress(endpoint) && endpoint.channelId === "web" ? "web" : lark?.receiveIdType === "open_id" ? "direct" : lark ? "group" : "external");
      return this.resources.create({ type: ADDRESS_TYPE, name, spec: { endpoint, aliases: [], type, name: options.name?.trim().slice(0, 200) || (isChannelAddress(endpoint) ? endpoint.endpoint : JSON.stringify(endpoint)),
        muted: options.muted ?? type !== "web" }, status: { people: members } });
    });
  }
  ref(target: AddressTarget, people: Iterable<PersonRef> = []) {
    return target.kind === "Address" ? addressRef(this.read(AddressRefSchema.parse(target))) : addressRef(this.observe(target, people));
  }
  view(ref: AddressRef) {
    const r = this.read(ref);
    return { ...r, status: { ...r.status, people: [...r.status.people] }, summaryText: summaryText(this.resources, r),
      participants: [...r.status.people].map(ref => { const person = this.resources.find<Person, PersonStatus>(PERSON_TYPE, ref.name, ref.namespace); return { ref, name: person?.metadata.uid === ref.uid ? person.spec.name : ref.name, clearance: person?.metadata.uid === ref.uid ? person.spec.clearance ?? "L1" : undefined }; }),
      summaryNote: summaryReference(this.resources, r), summaryVersion: contentVersion(r), recent: notes(this.resources, r.metadata.uid, "addresses") };
  }
  page(continuation?: string, person?: string) {
    const page = this.resources.page<AddressSpec, AddressStatus>(ADDRESS_TYPE, { namespace: "v1", limit: 20, continue: continuation,
      ...(person ? { matchIndex: { name: "people", value: person } } : {}) });
    return { items: page.items.filter(r => !r.metadata.deletionTimestamp).map(r => ({ ref: addressRef(r), ...r.spec, people: [...r.status.people] })), continue: page.metadata.continue };
  }
  setMuted(ref: AddressRef, muted: boolean, expected: boolean) {
    this.read(ref);
    return this.resources.patch<AddressSpec, AddressStatus>(ADDRESS_TYPE, ref.name, { type: "json", value: [
      { op: "test", path: "/spec/muted", value: expected }, { op: "replace", path: "/spec/muted", value: muted },
    ] });
  }
  async summarize(ref: AddressRef, text: string, version: string) {
    return summaryView(this.client, await writeSummary(this.client, this.read(ref), { text }, undefined, version));
  }
  recent(ref: AddressRef, continuation?: string) { return pageNotes(this.client, this.read(ref).metadata.uid, "addresses", continuation); }
}
