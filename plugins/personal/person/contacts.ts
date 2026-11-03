import type { Logger } from "pino";
import type { Address as Endpoint } from "@compforge/aide-plugin";
import { larkEndpoint, larkPersonAddress } from "../../../src/channel/address.ts";
import { equalResourceValue } from "../../../src/resource/value.ts";
import { Addresses, placeEndpoint } from "../address/service.ts";
import { ADDRESS_TYPE, addressRef, addressRefs, type AddressResource } from "../address/model.ts";
import { InputDefinition } from "../input/definition.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { PERSON_TYPE, personRef, type PersonIdentity, type PersonRef, type PersonResource } from "./model.ts";

/** @spec Contact discovery uses app-scoped human identities and enabled sending Channels only.
 * @spec New direct contacts are unmuted; rediscovery never overrides explicit mute or summary.
 * @link docs/personal/person.md#联系地址
 * @case tests/person-addresses.test.ts
 */
export class PersonContacts {
  private readonly addresses: Addresses;
  constructor(home: string, private readonly larkApps: readonly string[], private readonly log: Logger) {
    this.addresses = new Addresses(home);
    this.addresses.resources.storage.register("personal", [InputDefinition]);
  }
  ensure(person: Readonly<PersonResource>): Readonly<PersonResource> {
    return this.addresses.resources.storage.transaction(() => {
      const current = this.current(personRef(person));
      const refs = [...current.spec.addresses ?? []];
      for (const identity of current.spec.identities) {
        if (identity.provider !== "lark" || !this.larkApps.includes(identity.scope)) continue;
        const endpoint = larkPersonAddress(identity.scope, identity.id);
        let contact = this.addresses.find(endpoint);
        if (!contact) {
          // An earlier bot intake proves that this chat is the bot-human DM. Source DMs do not.
          contact = this.previousDirect(current, identity);
          if (contact) contact = this.alias(contact, endpoint);
        }
        contact = this.addresses.observe(contact ? addressRef(contact) : endpoint, [personRef(current)], { muted: false, type: "direct", name: current.spec.name });
        refs.push(addressRef(contact));
      }
      return this.link(current, refs);
    });
  }
  /** Only a Channel p2p event may equate chat_id with the sender's app-scoped open_id. */
  bindDirect(person: PersonRef, endpoint: Endpoint, openId: string): AddressResource {
    return this.addresses.resources.storage.transaction(() => {
      const current = this.current(person), chat = larkEndpoint(endpoint);
      const identity = current.spec.identities.find(i => i.provider === "lark" && i.scope === chat?.appId && i.id === openId);
      if (!chat || chat.receiveIdType !== "chat_id" || !identity || !this.larkApps.includes(chat.appId))
        throw new Error("Direct Address requires an identified sender in the enabled Lark Channel");
      const direct = larkPersonAddress(identity.scope, identity.id);
      const contact = this.addresses.find(direct) ?? this.addresses.find(endpoint)
        ?? this.addresses.observe(direct, [person], { type: "direct", muted: false, name: current.spec.name });
      const bound = this.alias(this.alias(contact, direct), endpoint);
      this.link(current, [...current.spec.addresses ?? [], addressRef(bound)]);
      return bound;
    });
  }
  linkAddress(person: PersonRef, address: AddressResource): void {
    this.addresses.resources.storage.transaction(() => {
      const current = this.current(person);
      this.link(current, [...current.spec.addresses ?? [], addressRef(address)]);
    });
  }
  private current(ref: PersonRef): PersonResource {
    const person = this.addresses.resources.get<PersonResource["spec"], PersonResource["status"]>(PERSON_TYPE, ref.name, ref.namespace);
    if (person.metadata.uid !== ref.uid || person.metadata.deletionTimestamp) throw new Error("Contact Person no longer exists");
    return person;
  }
  private link(person: PersonResource, refs: Iterable<import("../address/model.ts").AddressRef>) {
    const addresses = addressRefs(refs);
    if (equalResourceValue(person.spec.addresses, addresses)) return person;
    const updated = this.addresses.resources.replace(PERSON_TYPE, person.metadata.name, { ...person.spec, addresses }, person.status) as PersonResource;
    this.log.info({ personUid: person.metadata.uid, addressUids: [...addresses].map(ref => ref.uid) }, "Person contact Addresses reconciled");
    return updated;
  }
  private alias(address: AddressResource, raw: Endpoint): AddressResource {
    const endpoint = placeEndpoint(raw);
    if ([address.spec.endpoint, ...address.spec.aliases].some(e => equalResourceValue(e, endpoint))) return address;
    const previous = this.addresses.find(endpoint);
    if (previous && previous.metadata.uid !== address.metadata.uid) throw new Error(`Direct Address alias already belongs to ${previous.metadata.uid}`);
    const updated = this.addresses.resources.replace(ADDRESS_TYPE, address.metadata.name,
      { ...address.spec, aliases: [...address.spec.aliases, endpoint] }, address.status) as AddressResource;
    this.log.info({ addressUid: address.metadata.uid }, "Lark direct Address endpoint linked");
    return updated;
  }
  private previousDirect(person: PersonResource, identity: PersonIdentity): AddressResource | undefined {
    const resources = this.addresses.resources;
    const candidates = resources.list<AddressResource["spec"], AddressResource["status"]>(ADDRESS_TYPE, { matchIndex: { name: "people", value: person.metadata.uid } });
    for (const address of candidates) {
      if (address.metadata.deletionTimestamp || address.spec.type !== "direct" || larkEndpoint(address.spec.endpoint)?.appId !== identity.scope) continue;
      let continuation: string | undefined;
      do {
        const page = resources.page<InputSpec, InputStatus>(INPUT_TYPE, { limit: 100, continue: continuation, matchIndex: { name: "address", value: address.metadata.uid } });
        if (page.items.some(input => {
          const evidence = input.spec.observation as { provider?: string; accountId?: string; sender?: { type?: string; id?: string } } | undefined;
          return input.spec.origin === "channel" && input.spec.originId === "lark" && evidence?.provider === "lark"
            && evidence.accountId === identity.scope && evidence.sender?.type === "user" && evidence.sender.id === identity.id;
        })) return address;
        continuation = page.metadata.continue || undefined;
      } while (continuation);
    }
  }
}
