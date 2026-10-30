import { summaryText } from "../plugins/personal/note/summary.ts";
import { seedSummaryPatch, createWithSummarySync } from "./summary-fixture.ts";
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ResourceStorage } from "../src/host/resource/storage.ts";
import { PluginResourceStore } from "../src/host/plugin/resource/store.ts";
import { PersonDefinition } from "../plugins/personal/person/definition.ts";
import { PERSON_TYPE, LOCAL_ME } from "../plugins/personal/person/model.ts";
import { browsePersons } from "../plugins/personal/person/browse.ts";

const marks = { identities: [LOCAL_ME] };
function setup(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "aide-person-list-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const storage = ResourceStorage.open(home); storage.register("personal", [PersonDefinition]);
  const store = new PluginResourceStore({ home, pluginInstanceId: "personal" });
  return { storage, store, create(id: string, summary = "", name = id, me = false) {
    return createWithSummarySync(store, { type: PERSON_TYPE, name: id, spec: { name, identities: me ? [LOCAL_ME] : [] },
      status: { summary, updatedAt: new Date().toISOString(), updatedBy: "user" } });
  } };
}

/** @case Search and understanding-first ordering apply before SQL paging; Me stays outside totals and page quotas. */
test("Person SQL pages are complete and understanding-first, with explicit Me pinned on every matching page", t => {
  const f = setup(t);
  const people = Array.from({ length: 23 }, (_, i) => f.create(`person-${String(i).padStart(2, "0")}`, i % 3 === 0 ? "Known" : " \n\t ", `Alice ${i}`));
  f.create("me", "", "Alice Me", true);
  const pages = [1, 2, 3].map(page => browsePersons(f.storage, marks, { page, pageSize: 10 }));
  assert.deepEqual(pages.map(p => p.items.length), [10, 10, 3]);
  assert.ok(pages.every(p => p.total === 23 && p.pinned[0]!.id === "me" && p.pages === 3));
  const expected = [...people.filter(p => summaryText(f.store, p).trim()), ...people.filter(p => !summaryText(f.store, p).trim())];
  assert.deepEqual(pages.flatMap(p => p.items.map(i => i.id)), expected.map(p => p.metadata.name));
  assert.equal(browsePersons(f.storage, marks, { q: "ALICE" }).total, 23);
  const one = browsePersons(f.storage, marks, { q: "Alice 22" });
  assert.equal(one.total, 1); assert.equal(one.pinned.length, 0); assert.equal(one.items[0]!.id, "person-22");
  assert.equal(browsePersons(f.storage, { identities: [] }).total, 24, "Names never determine Me");
  assert.equal(browsePersons(f.storage, marks, { q: "nobody", page: 99 }).page, 1);
  assert.equal(browsePersons(f.storage, marks, { q: "' OR 1=1 --" }).total, 0);
});

test("Person SQL selection follows reordered profiles while explicit page requests stay fixed", t => {
  const f = setup(t);
  const people = Array.from({ length: 21 }, (_, i) => f.create(`person-${String(i).padStart(2, "0")}`));
  const selected = people[20]!;
  assert.equal(browsePersons(f.storage, marks, { selectedId: selected.metadata.name, pageSize: 10 }).page, 3);
  seedSummaryPatch(f.store, PERSON_TYPE, selected.metadata.name, { summary: "Now known" });
  assert.equal(browsePersons(f.storage, marks, { selectedId: selected.metadata.name, pageSize: 10 }).page, 1);
  assert.equal(browsePersons(f.storage, marks, { selectedId: selected.metadata.name, pageSize: 10, page: 2 }).page, 2);
  f.store.requestDeletion(PERSON_TYPE, selected.metadata.name);
  assert.equal(browsePersons(f.storage, marks, { page: 3, pageSize: 10 }).page, 2);
});

test("Exact-name merge candidates span all pages and exclude only the selected UID", t => {
  const f = setup(t);
  const people = Array.from({ length: 24 }, (_, i) => f.create(`person-${String(i).padStart(2, "0")}`, "", "Same"));
  f.create("different", "", "Same prefix");
  const selected = people[23]!;
  const pages = [1, 2, 3].map(page => browsePersons(f.storage, marks, { page, pageSize: 10, name: "Same", excludeUid: selected.metadata.uid }));
  assert.ok(pages.every(p => p.total === 23));
  assert.deepEqual(new Set(pages.flatMap(p => p.items.map(i => i.uid))), new Set(people.slice(0, 23).map(p => p.metadata.uid)));
});

test("Person lists return bounded summaries, exclude foreign scopes and do not refresh retention access", t => {
  const f = setup(t);
  f.create("person", "s".repeat(2000));
  f.storage.register("foreign", [PersonDefinition]);
  createWithSummarySync(new PluginResourceStore({ home: f.storage.home, pluginInstanceId: "foreign" }), { type: PERSON_TYPE, name: "foreign",
    spec: { name: "Other", identities: [] }, status: { summary: "", updatedAt: new Date().toISOString(), updatedBy: "user" } });
  const before = f.storage.db.prepare("SELECT key, accessed FROM resources ORDER BY key").all();
  const result = browsePersons(f.storage, marks);
  assert.equal(result.total, 1); assert.equal(result.items[0]!.preview.length, 80);
  assert.ok(!("identities" in result.items[0]!)); assert.ok(!("status" in result.items[0]!));
  assert.deepEqual(f.storage.db.prepare("SELECT key, accessed FROM resources ORDER BY key").all(), before);
});
