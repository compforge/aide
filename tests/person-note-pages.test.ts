import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { Aide } from "../src/app.ts";
import { httpChannel } from "../src/api/index.ts";
import { fakeOptions } from "./fake-harness.ts";
import { seedNotes } from "./fixtures/notes.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { NOTE_TYPE } from "../plugins/personal/note/model.ts";
import { writeSummary } from "../plugins/personal/note/summary.ts";
import type { PersonNotesView } from "../src/api/types.ts";
import type { StoredResource } from "../src/host/resource/storage.ts";

/** @case Person pages cover all current related Notes, decode only the requested bodies, retain nature and fence old Person UIDs. */
test("Person Note pages share Topic paging without decoding off-page content", async t => {
  const dir = mkdtempSync(join(tmpdir(), "aide-person-note-pages-")), log = pino({ level: "silent" });
  const aide = new Aide(dir, fakeOptions({ execute: async () => { throw new Error("Unexpected inference"); } }, dir), log);
  const server = httpChannel(aide, log);
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await aide.close(); rmSync(dir, { recursive: true, force: true });
  });
  const resources = aide.topics.resources, client = createResourceClient(resources);
  const person = await aide.persons.observe({ provider: "test", scope: "pages", id: "one" }, "One");
  const other = await aide.persons.observe({ provider: "test", scope: "pages", id: "two" }, "Two");
  const empty = await aide.persons.observe({ provider: "test", scope: "pages", id: "empty" }, "Empty");
  const entries = Array.from({ length: 17 }, (_, i) => ({ id: `note-${String(i).padStart(2, "0")}`, text: "完整正文" + "x".repeat(5000) + i, nature: "procedural" as const,
    updatedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, Math.floor(i / 2))).toISOString() }));
  await seedNotes(client, person, entries);
  await seedNotes(client, other, [{ id: "other", text: "Other person's record" }]);
  await writeSummary(client, person, { text: "Separate person summary" });
  aide.start = async () => {};
  const storage = resources.storage, decode = storage.decode.bind(storage);
  let decodedNotes = 0;
  storage.decode = <T extends StoredResource = StoredResource>(scope: string, data: string): T => {
    const value = decode<T>(scope, data); if (value.object.kind === "Note") decodedNotes++; return value;
  };
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const query = { id: person.metadata.name, uid: person.metadata.uid };
  async function page(number: number) {
    decodedNotes = 0;
    const response = await fetch(base + "/persons/notes?" + new URLSearchParams({ ...query, page: String(number) }));
    assert.equal(response.status, 200);
    const result = await response.json() as PersonNotesView;
    assert.equal(result.pageSize, 5); assert.equal(decodedNotes, result.items.length); return result;
  }
  const first = await page(1); assert.equal(first.total, 17); assert.equal(first.pages, 4);
  assert.equal(first.items[0]!.nature, "procedural");
  const all = [...first.items];
  for (let i = 2; i <= 4; i++) all.push(...(await page(i)).items);
  assert.deepEqual(all.map(n => n.text), entries.toReversed().map(n => n.text));
  const last = await page(100); assert.equal(last.page, 4); assert.equal(last.items.length, 2);
  for (const note of last.items) await client.delete(resources.get(NOTE_TYPE, note.id), note.id);
  assert.equal((await page(4)).page, 3);
  const emptyPage = await (await fetch(base + "/persons/notes?" + new URLSearchParams({ id: empty.metadata.name, uid: empty.metadata.uid, page: "1" }))).json() as PersonNotesView;
  assert.equal(emptyPage.total, 0); assert.equal(emptyPage.page, 1); assert.deepEqual(emptyPage.items, []);
  assert.equal((await fetch(base + "/persons/notes?" + new URLSearchParams({ ...query, uid: "stale", page: "1" }))).status, 404);
  for (const suffix of ["page=0", "page=1.5", "pageSize=0", "pageSize=101", "page=1&continue=old"]) {
    assert.equal((await fetch(base + "/persons/notes?" + new URLSearchParams(query) + "&" + suffix)).status, 400);
  }
  const old = await (await fetch(base + "/persons/notes?" + new URLSearchParams(query))).json();
  assert.equal(typeof old.continue, "string", "Legacy cursor requests retain their response shape");
  assert.equal((await fetch(base + "/persons.js")).status, 200);
});
