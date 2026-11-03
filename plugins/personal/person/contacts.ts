import type { Logger } from "pino";
import { identityContactLocator } from "../../../src/channel/address.ts";
import { Addresses } from "../address/service.ts";
import { addressRef } from "../address/model.ts";
import { PERSON_TYPE, personRef, type PersonResource } from "./model.ts";

/** @spec Contact discovery creates Addresses for enabled Channels, without copying the relationship onto Person.
 * @spec New direct contacts are unmuted; rediscovery never overrides explicit mute or summary.
 * @link docs/personal/person.md#联系地址
 * @case tests/person-addresses.test.ts
 */
export class PersonContacts {
  private readonly addresses: Addresses;
  constructor(home: string, private readonly larkApps: readonly string[], private readonly log: Logger) {
    this.addresses = new Addresses(home);
  }
  ensure(person: Readonly<PersonResource>): Readonly<PersonResource> {
    return this.addresses.resources.storage.transaction(() => {
      const current = this.addresses.resources.get<PersonResource["spec"], PersonResource["status"]>(PERSON_TYPE, person.metadata.name, person.metadata.namespace);
      if (current.metadata.uid !== person.metadata.uid || current.metadata.deletionTimestamp) throw new Error("Contact Person no longer exists");
      for (const identity of current.spec.identities) {
        if (identity.provider !== "lark" || !this.larkApps.includes(identity.scope)) continue;
        const locator = identityContactLocator(identity)!;
        const existing = this.addresses.find(locator);
        if (existing?.status.retiring) continue;
        const contact = this.addresses.observe(existing ? addressRef(existing) : locator, [personRef(current)], { muted: false, type: "direct", name: current.spec.name });
        if (!existing) this.log.info({ personUid: current.metadata.uid, addressUid: contact.metadata.uid }, "Person contact Address discovered");
      }
      return current;
    });
  }
}
