import type { PluginResourceStore } from "../../../src/host/plugin/resource/store.ts";
import type { PageQuery } from "../browse.ts";
import { browseNotePage } from "../note/browse.ts";
import { PERSON_TYPE, type Person, type PersonStatus } from "./model.ts";

/** @spec Person Note pages pin the current Person UID; same-name replacements never inherit records. */
export function browsePersonNotes(resources: PluginResourceStore, id: string, uid: string, query: PageQuery = {}) {
  return resources.storage.transaction(() => {
    const person = resources.find<Person, PersonStatus>(PERSON_TYPE, id, "v1");
    if (!person || person.metadata.deletionTimestamp || person.metadata.uid !== uid) return;
    return browseNotePage(resources.storage, uid, "people", query);
  });
}
