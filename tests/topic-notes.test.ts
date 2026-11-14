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
import { TOPIC_TYPE } from "../plugins/personal/topic/model.ts";
import { resourceRef } from "../plugins/personal/input/state.ts";
import { writeSummary } from "../plugins/personal/note/summary.ts";
import type { browseTopicNotes } from "../plugins/personal/topic/notes.ts";
import type { StoredResource } from "../src/host/resource/storage.ts";

/** @case Pages cover all retained Topic Notes with full text, decode only five bodies, and exclude summaries, deleted Notes and other subjects. */
test("Topic Note HTTP pages use indexed scope and preserve full text beyond the context budget", async t => {
  const dir = mkdtempSync(join(tmpdir(), "aide-topic-notes-")), log = pino({ level: "silent" });
  const aide = new Aide(dir, fakeOptions({ execute: async () => { throw new Error("Unexpected inference"); } }, dir), log);
  const server = httpChannel(aide, log);
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await aide.close(); rmSync(dir, { recursive: true, force: true });
  });
  const resources = aide.topics.resources, client = createResourceClient(resources);
  const topic = await aide.topics.ensure("notes"), child = await aide.topics.ensure("child"), other = await aide.topics.ensure("other");
  await aide.topics.ensure("empty");
  resources.replace(TOPIC_TYPE, child.metadata.name, { ...child.spec, parentRef: resourceRef(topic) }, child.status);
  const body = "完整正文" + "x".repeat(5000) + "末尾";
  const entries = Array.from({ length: 47 }, (_, i) => ({ id: `note-${String(i).padStart(2, "0")}`, text: body,
    updatedAt: new Date(Date.UTC(2026, 10, 1, 0, 0, Math.floor(i / 2))).toISOString() }));
  await seedNotes(client, topic, entries);
  await seedNotes(client, child, [{ id: "child", text: "Child Note" }]);
  await seedNotes(client, other, [{ id: "other", text: "Other Note" }]);
  await writeSummary(client, topic, { text: "Separate summary" });
  aide.start = async () => {};
  aide.topics.outputs = () => { throw new Error("Unexpected Output history"); };
  aide.topics.outputStore.streams.reader = () => { throw new Error("Unexpected Stream read"); };
  aide.topics.get = () => { throw new Error("Unexpected full Topic projection"); };
  const storage = resources.storage, decode = storage.decode.bind(storage);
  let decodedNotes = 0;
  storage.decode = <T extends StoredResource = StoredResource>(scope: string, data: string): T => {
    const value = decode<T>(scope, data);
    if (value.object.kind === "Note") decodedNotes++;
    return value;
  };
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  async function page(topicId = "notes", number = 1) {
    decodedNotes = 0;
    const response = await fetch(base + "/topics/notes?" + new URLSearchParams({ topicId, page: String(number) }));
    assert.equal(response.status, 200);
    const result = await response.json() as ReturnType<typeof browseTopicNotes>;
    assert.equal(result.pageSize, 5); assert.ok(result.items.length <= 5);
    assert.equal(decodedNotes, result.items.length, "Only returned Note bodies are decoded");
    return result;
  }
  const first = await page();
  assert.equal(first.total, 47); assert.equal(first.pages, 10);
  const ids: string[] = [];
  for (let number = 1; number <= first.pages; number++) {
    const result = await page("notes", number);
    for (const note of result.items) { assert.equal(note.text, body); ids.push(note.id); }
  }
  assert.deepEqual(ids, entries.toReversed().map(entry => `${topic.metadata.uid}-${entry.id}`), "Timestamp ties have stable ordering without omissions or duplicates");
  const last = await page("notes", 100);
  assert.equal(last.page, 10); assert.equal(last.items.length, 2);
  for (const id of last.items.map(note => note.id)) await client.delete(resources.get(NOTE_TYPE, id), id);
  const clamped = await page("notes", 10);
  assert.equal(clamped.total, 45); assert.equal(clamped.page, 9);
  for (const topicId of ["empty", "missing"]) {
    const result = await page(topicId);
    assert.equal(result.total, 0); assert.equal(result.page, 1); assert.deepEqual(result.items, []);
  }
  assert.equal(aide.topics.resource("missing"), undefined);
  for (const query of ["page=0", "page=1.5", "pageSize=0", "pageSize=101"]) {
    assert.equal((await fetch(base + "/topics/notes?topicId=notes&" + query)).status, 400);
  }
  const bundle = await fetch(base + "/app.js");
  assert.equal(bundle.status, 200); assert.ok((await bundle.text()).length > 0);
});
