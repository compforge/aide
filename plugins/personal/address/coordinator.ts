import type { Logger } from "pino";
import { isDeepStrictEqual } from "node:util";
import type { Address as Endpoint } from "@compforge/aide-plugin";
import { larkEndpoint, larkPersonAddress } from "../../../src/channel/address.ts";
import { Addresses } from "./service.ts";
import { ADDRESS_TYPE, addressRef, addressRefs, locators, type AddressResource, type AddressRef } from "./model.ts";
import { INPUT_TYPE, type InputSpec, type InputStatus } from "../input/model.ts";
import { PERSON_TYPE, personRefs, type Person, type PersonStatus } from "../person/model.ts";
import { TOPIC_TYPE, type TopicSpec, type TopicStatus } from "../topic/model.ts";
import { NOTE_TYPE, type NoteSpec, type NoteStatus } from "../note/model.ts";
import { OUTPUT_TYPE } from "../output/model.ts";

/** @spec Address owns equivalence and merge progress. Inputs persist before coordination and immutable historical refs never redirect.
 * @case tests/address-locators.test.ts
 * @link docs/personal/address.md
 */
export class AddressCoordinator {
  private readonly addresses: Addresses;
  constructor(home: string, private readonly apps: readonly string[], private readonly log: Logger,
    private readonly remapDefault: (from: AddressRef, to: AddressRef) => void = () => {}) { this.addresses = new Addresses(home); }
  reconcile(ref: AddressRef): { requeueAfterMs?: number } | undefined {
    return this.addresses.resources.storage.transaction(() => {
      const address = this.addresses.read(ref);
      if (address.status.retiring) return;
      const source = [...address.status.mergeSources ?? []][0];
      if (source) return this.drain(address, source);
      for (const locator of address.spec.locators) {
        const chat = larkEndpoint(locator);
        if (address.spec.type !== "direct" || chat?.receiveIdType !== "chat_id" || !this.apps.includes(chat.appId)) continue;
        let continuation: string | undefined;
        do {
          const page = this.addresses.resources.page<InputSpec, InputStatus>(INPUT_TYPE, { limit: 100, continue: continuation,
            matchIndex: { name: "address", value: ref.uid } });
          for (const input of page.items) {
            const e = input.spec.observation as { provider?: string; accountId?: string; chatId?: string; chatType?: string; sender?: { type?: string; id?: string } } | undefined;
            if (input.spec.origin !== "channel" || input.spec.originId !== "lark" || e?.provider !== "lark" || e.chatType !== "p2p"
              || e.accountId !== chat.appId || e.chatId !== chat.receiveId || e.sender?.type !== "user" || !e.sender.id || !input.spec.sender) continue;
            const person = this.addresses.resources.find<Person, PersonStatus>(PERSON_TYPE, input.spec.sender.name, "v1");
            if (!person || person.metadata.uid !== input.spec.sender.uid || person.metadata.deletionTimestamp
              || !person.spec.identities.some(i => i.provider === "lark" && i.scope === chat.appId && i.id === e.sender!.id)) continue;
            return this.bind(address, larkPersonAddress(chat.appId, e.sender.id), person.metadata.uid);
          }
          continuation = page.metadata.continue || undefined;
        } while (continuation);
      }
    });
  }
  private bind(address: AddressResource, locator: Endpoint, personUid: string) {
    if ([...address.spec.locators].some(value => isDeepStrictEqual(value, locator))) return;
    const other = this.addresses.find(locator);
    if (!other) {
      this.addresses.resources.replace(ADDRESS_TYPE, address.metadata.name, { ...address.spec, locators: locators([...address.spec.locators, locator]) }, address.status);
      this.log.info({ addressUid: address.metadata.uid }, "Address locator discovered from bot p2p Input");
      return;
    }
    if (other.metadata.uid === address.metadata.uid) return;
    // A peer mismatch is evidence of two places, never a reason to silently bind or delete either.
    const members = [...other.status.people];
    if (other.spec.type !== "direct" || members.some(p => p.uid !== personUid) || other.status.retiring || other.status.mergeSources?.size)
      throw new Error(`Address equivalence conflicts with peer or merge ownership: ${other.metadata.uid}`);
    const r = this.addresses.resources, muted = address.spec.muted || other.spec.muted;
    r.replace(ADDRESS_TYPE, other.metadata.name, { ...other.spec, muted }, { ...other.status, retiring: true });
    r.replace(ADDRESS_TYPE, address.metadata.name, { ...address.spec, muted, locators: locators([...address.spec.locators, ...other.spec.locators]) }, { ...address.status,
      people: personRefs([...address.status.people, ...other.status.people]), mergeSources: addressRefs([addressRef(other)]) });
    this.log.info({ addressUid: address.metadata.uid, sourceUid: other.metadata.uid, muted }, "Address merge started from proven bot p2p locators");
    return { requeueAfterMs: 100 };
  }
  private drain(address: AddressResource, source: AddressRef) {
    const r = this.addresses.resources, from = r.find<AddressResource["spec"], AddressResource["status"]>(ADDRESS_TYPE, source.name, "v1");
    if (!from || from.metadata.uid !== source.uid || from.metadata.deletionTimestamp) {
      r.replace(ADDRESS_TYPE, address.metadata.name, address.spec, { ...address.status, mergeSources: addressRefs([...address.status.mergeSources!].filter(s => s.uid !== source.uid)) });
      return { requeueAfterMs: 100 };
    }
    if (!from.status.retiring) throw new Error("Address merge source is not retiring");
    const to = addressRef(address);
    const topics = r.page<TopicSpec, TopicStatus>(TOPIC_TYPE, { limit: 50, matchIndex: { name: "address", value: source.uid } }).items;
    for (const topic of topics) r.replace(TOPIC_TYPE, topic.metadata.name, { ...topic.spec, address: to }, topic.status);
    if (topics.length) return { requeueAfterMs: 100 };
    this.remapDefault(source, to);
    const blocked = r.page(OUTPUT_TYPE, { limit: 1, matchIndex: { name: "activeAddress", value: source.uid } }).items;
    if (blocked.length) {
      this.log.info({ addressUid: address.metadata.uid, sourceUid: source.uid, outputUid: blocked[0]!.metadata.uid }, "Address merge awaits unresolved Output");
      return { requeueAfterMs: 5000 };
    }
    const notes = r.page<NoteSpec, NoteStatus>(NOTE_TYPE, { limit: 50, matchIndex: { name: "addresses", value: source.uid } }).items;
    for (const note of notes) r.replace(NOTE_TYPE, note.metadata.name, { ...note.spec,
      addresses: addressRefs([...note.spec.addresses].map(ref => ref.uid === source.uid ? to : ref)) }, note.status);
    if (notes.length) return { requeueAfterMs: 100 };
    // The old summary remains an independently classified Note, discoverable at the survivor. Its authorship and body are untouched.
    const summary = r.page<NoteSpec, NoteStatus>(NOTE_TYPE, { limit: 1, matchIndex: { name: "summaryOf", value: source.uid } }).items[0];
    if (summary) r.replace(NOTE_TYPE, summary.metadata.name, { ...summary.spec, addresses: addressRefs([...summary.spec.addresses, to]) }, summary.status);
    r.requestDeletion(ADDRESS_TYPE, source.name, new Date(), "v1", { uid: from.metadata.uid, resourceVersion: from.metadata.resourceVersion });
    r.replace(ADDRESS_TYPE, address.metadata.name, { ...address.spec,
      locators: locators([...address.spec.locators, ...from.spec.locators]), muted: address.spec.muted || from.spec.muted },
      { ...address.status, mergeSources: addressRefs([...address.status.mergeSources!].filter(s => s.uid !== source.uid)) });
    this.log.info({ addressUid: address.metadata.uid, deletedAddressUid: source.uid }, "Address locators and current references merged; duplicate deletion requested");
    return { requeueAfterMs: 100 };
  }
}
