import type { ResourceStorage } from "../../../src/host/resource/storage.ts";
import { pageBounds, pageSize, type PageQuery } from "../browse.ts";
import { ADDRESS_TYPE, type AddressRef, type AddressSpec } from "./model.ts";

export interface AddressBrowseQuery extends PageQuery { selectedUid?: string }
export interface AddressListItem { ref: AddressRef; name: string; type: AddressSpec["type"]; muted: boolean }
export type AddressListView = ReturnType<typeof browseAddresses>;
const field = (path: string) => `json_extract(data, '$.object.${path}')`;
const scope = `scope = 'personal' AND kind = 'aide.dev/Address' AND ${field("apiVersion")} = '${ADDRESS_TYPE.apiVersion}'
  AND ${field("metadata.namespace")} = 'v1' AND ${field("metadata.deletionTimestamp")} IS NULL`;
const columns = `uid, ${field("metadata.name")} AS id, ${field("spec.name")} AS name,
  ${field("spec.type")} AS type, ${field("spec.muted")} AS muted`;
const order = "created DESC, key DESC";

/**
 * @spec Default Address is pinned outside totals and page quotas. Live addresses are ordered and paged in SQL without loading details.
 * @spec Deep links follow the selected UID unless an explicit page is requested; stale defaults never pin a recreated Address.
 * @link docs/personal/address.md
 */
export function browseAddresses(storage: ResourceStorage, defaultAddress: AddressRef, query: AddressBrowseQuery = {}) {
  const size = pageSize(query), db = storage.db;
  const project = (row: Record<string, unknown>): AddressListItem => ({
    ref: { ...ADDRESS_TYPE, namespace: "v1", name: row.id as string, uid: row.uid as string },
    name: row.name as string, type: row.type as AddressSpec["type"], muted: Boolean(row.muted),
  });
  return storage.transaction(() => {
    const pinned = db.prepare(`SELECT ${columns} FROM resources WHERE ${scope} AND uid = ? AND ${field("metadata.name")} = ?`)
      .all(defaultAddress.uid, defaultAddress.name).map(project);
    const where = `${scope} AND uid <> ?`, excluded = pinned[0]?.ref.uid ?? "";
    const total = Number(db.prepare(`SELECT count(*) AS n FROM resources WHERE ${where}`).get(excluded)!.n);
    let requested = query.page;
    if (requested === undefined && query.selectedUid) {
      const position = db.prepare(`SELECT position FROM (SELECT uid, row_number() OVER (ORDER BY ${order}) AS position
        FROM resources WHERE ${where}) WHERE uid = ?`).get(excluded, query.selectedUid);
      if (position) requested = Math.ceil(Number(position.position) / size);
    }
    const bounds = pageBounds(total, size, requested);
    const items = db.prepare(`SELECT ${columns} FROM resources WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(excluded, size, (bounds.page - 1) * size).map(project);
    return { ...bounds, items, pinned };
  });
}
