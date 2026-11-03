import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Addresses } from "../plugins/personal/address/service.ts";
import { ADDRESS_TYPE, addressRef } from "../plugins/personal/address/model.ts";
import { browseAddresses } from "../plugins/personal/address/browse.ts";
import { webAddress } from "../src/channel/address.ts";

function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-address-list-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const addresses = new Addresses(home), storage = addresses.resources.storage;
  const entries = Array.from({ length: 24 }, (_, i) => addresses.observe(webAddress(`place-${i}`), [], { name: `Place ${i}` }));
  storage.db.prepare("UPDATE resources SET created = ? WHERE kind = 'aide.dev/Address'").run("2026-11-01T00:00:00.000Z");
  entries.sort((a, b) => a.metadata.name < b.metadata.name ? 1 : -1);
  return { addresses, storage, entries };
}

/** @case Default outside the first SQL window is pinned on every page without duplicates, omissions or quota loss. */
test("Address SQL pages pin Default outside quotas and follow deep links with stable ordering", t => {
  const { storage, entries } = setup(t), pinned = addressRef(entries[23]!);
  const pages = [1, 2, 3].map(page => browseAddresses(storage, pinned, { page, pageSize: 10 }));
  assert.deepEqual(pages.map(page => page.items.length), [10, 10, 3]);
  assert.ok(pages.every(page => page.total === 23 && page.pages === 3 && page.pinned[0]?.ref.uid === pinned.uid));
  assert.deepEqual(pages.flatMap(page => page.items.map(item => item.ref.uid)), entries.slice(0, 23).map(entry => entry.metadata.uid));
  const selectedUid = entries[22]!.metadata.uid;
  assert.equal(browseAddresses(storage, pinned, { selectedUid, pageSize: 10 }).page, 3);
  assert.equal(browseAddresses(storage, pinned, { selectedUid, page: 2, pageSize: 10 }).page, 2);
  assert.equal(browseAddresses(storage, pinned, { selectedUid: pinned.uid, pageSize: 10 }).page, 1);
  assert.equal(browseAddresses(storage, pinned, { page: 999, pageSize: 10 }).page, 3);
  const changed = browseAddresses(storage, addressRef(entries[0]!), { page: 3, pageSize: 10 });
  assert.equal(changed.page, 3); assert.equal(changed.items.length, 3);
  assert.ok(changed.items.some(item => item.ref.uid === pinned.uid), "Previous default rejoins the normal pages");
});

/** @case Deletion filtering precedes count and paging; a missing default does not hide another incarnation. */
test("Address pages exclude deleting entries and clamp after deletion", t => {
  const { addresses, storage, entries } = setup(t), pinned = addressRef(entries[23]!);
  for (const entry of entries.slice(20, 23)) addresses.resources.requestDeletion(ADDRESS_TYPE, entry.metadata.name);
  const last = browseAddresses(storage, pinned, { page: 3, pageSize: 10 });
  assert.equal(last.total, 20); assert.equal(last.page, 2); assert.equal(last.items.length, 10);
  const stale = browseAddresses(storage, { ...pinned, uid: "old-incarnation" }, { pageSize: 100 });
  assert.equal(stale.pinned.length, 0); assert.equal(stale.total, 21);
  assert.ok(stale.items.some(item => item.ref.uid === pinned.uid));
  for (const entry of [...entries.slice(0, 20), entries[23]!]) addresses.resources.requestDeletion(ADDRESS_TYPE, entry.metadata.name);
  const empty = browseAddresses(storage, pinned, { page: 99 });
  assert.deepEqual({ items: empty.items, pinned: empty.pinned, total: empty.total, page: empty.page, pages: empty.pages },
    { items: [], pinned: [], total: 0, page: 1, pages: 1 });
});
