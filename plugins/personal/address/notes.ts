import type { PluginResourceStore } from "../../../src/host/plugin/resource/store.ts";
import type { PageQuery } from "../browse.ts";
import { browseNotePage } from "../note/browse.ts";
import { ADDRESS_TYPE, type AddressSpec, type AddressStatus } from "./model.ts";

/** @spec Address Note pages pin the current Address UID; same-name replacements never inherit records. */
export function browseAddressNotes(resources: PluginResourceStore, id: string, uid: string, query: PageQuery = {}) {
  return resources.storage.transaction(() => {
    const address = resources.find<AddressSpec, AddressStatus>(ADDRESS_TYPE, id, "v1");
    if (!address || address.metadata.deletionTimestamp || address.metadata.uid !== uid) return;
    return browseNotePage(resources.storage, uid, "addresses", query);
  });
}
