import assert from "node:assert/strict";
import { test } from "node:test";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import type { StoredResource } from "../src/host/resource/storage.ts";
import { Aide } from "../src/app.ts";
import { httpChannel } from "../src/api/index.ts";
import { topicView } from "../src/channel/view.ts";
import type { TopicView } from "../src/channel/view.ts";
import { fakeOptions } from "./fake-harness.ts";
import { seedInput } from "./topic-fixture.ts";
import { createResourceClient } from "../src/host/plugin/resource/client.ts";
import { writeSummary } from "../plugins/personal/note/summary.ts";
import { seedNotes } from "./fixtures/notes.ts";

/** @case Independent panel reads never materialize dialogue or raw observation evidence. */
test("Topic panels read independently and dialogue pages do not decode off-page inputs", async t => {
  const root = mkdtempSync(join(tmpdir(), "aide-topic-panels-"));
  const log = pino({ level: "silent" });
  const aide = new Aide(root, fakeOptions({ async chief() { return ""; }, async execute() { throw new Error("Unexpected inference"); } }, root), log);
  const server = httpChannel(aide, log);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await aide.close(); rmSync(root, { recursive: true, force: true }); });
  // Seed completed facts without starting background agents.
  for (let i = 0; i < 65; i++) await seedInput(aide.topics, `fact-${String(i).padStart(3, "0")}`,
    { origin: "source", originId: "personal.environments", topicId: "history", text: `事实 ${i}`, observation: { large: "x".repeat(100_000) } }, { phase: "done" });
  const topic = aide.topics.resource("history")!;
  const client = createResourceClient(aide.topics.resources);
  await writeSummary(client, topic, { text: "独立摘要" });
  await seedNotes(client, aide.topics.resource("history")!, [{ id: "recent", text: "独立近期记录" }]);
  // These legacy full projections must not be on any panel read path.
  aide.outputs = () => { throw new Error("global output projection"); };
  aide.topics.get = () => { throw new Error("full topic projection"); };
  aide.topics.runs = () => { throw new Error("full input history"); };
  aide.start = async () => {};
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const summary = await (await fetch(base + "/topics/summary?topicId=history")).json();
  assert.equal(summary.summary, "独立摘要");
  assert.equal(summary.recent, undefined);
  const recent = await (await fetch(base + "/topics/recent?topicId=history")).json();
  assert.equal(recent.length, 1); assert.equal(recent[0].text, "独立近期记录");
  const originalRead = aide.topics.resources.storage.read.bind(aide.topics.resources.storage);
  let decodedInputs = 0;
  aide.topics.resources.storage.read = <T extends StoredResource = StoredResource>(key: string, touch?: boolean) => { const r = originalRead<T>(key, touch); if (r?.object.kind === "Input") decodedInputs++; return r; };
  const first = topicView(aide, "history");
  assert.equal(decodedInputs, 10);
  assert.equal(first.blocks.filter(b => b.type === "input").length, 10);
  assert.ok(first.meta.before);
  assert.ok(JSON.stringify(first).length < 60_000, "Raw observations never enter the dialogue");
  const second = topicView(aide, "history", first.meta.before!);
  const pages = [first, second];
  while (pages.at(-1)!.meta.before) {
    assert.ok(pages.length < 8, "Pagination must make progress");
    pages.push(topicView(aide, "history", pages.at(-1)!.meta.before!));
  }
  assert.equal(pages.length, 7);
  assert.ok(pages.every(page => page.blocks.filter(b => b.type === "input").length <= 10));
  const ids = pages.flatMap(page => page.blocks.filter(b => b.type === "input").map(b => b.id));
  assert.equal(ids.length, 65); assert.equal(new Set(ids).size, 65);
  await seedInput(aide.topics, "new-arrival", { origin: "source", originId: "personal.environments", topicId: "history", text: "新到达" }, { phase: "done" });
  assert.deepEqual(topicView(aide, "history", first.meta.before!).blocks, second.blocks, "New arrivals do not shift the older page boundary");
  assert.equal((await fetch(base + "/topics/history?topicId=history&before=invalid")).status, 400);
  assert.equal((await fetch(base + "/topics/history?topicId=other&before=" + first.meta.before)).status, 400);
  const bundle = await fetch(base + "/app.js"); assert.equal(bundle.status, 200);
});

/** @case Lazy history does not decode bodies, and a detail request reads only its scoped message. */
test("Topic message lists skip large bodies and detail requests enforce Topic and message identities", async t => {
  const root = mkdtempSync(join(tmpdir(), "aide-message-details-"));
  const log = pino({ level: "silent" });
  const aide = new Aide(root, fakeOptions({ async chief() { return ""; }, async execute() { throw new Error("Unexpected inference"); } }, root), log);
  const server = httpChannel(aide, log);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await aide.close(); rmSync(root, { recursive: true, force: true }); });
  const body = "Long message " + "x".repeat(30_000) + "BODY_TAIL";
  for (let i = 0; i < 12; i++) await seedInput(aide.topics, `message-${i}`, {
    origin: "channel", originId: "web", topicId: "messages", text: body, observation: { evidence: "y".repeat(100_000) },
  }, { phase: "done", outputs: [{ id: `reply-${i}`, topicId: "messages", workId: null, text: body, at: new Date(Date.now() + i).toISOString() }] });
  const other = await seedInput(aide.topics, "other-message", { origin: "source", originId: "personal.environments", topicId: "other", text: "Other Topic secret" }, { phase: "done" });
  aide.start = async () => {};
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const storage = aide.topics.resources.storage, originalRead = storage.read.bind(storage);
  let bodies = 0;
  storage.read = <T extends StoredResource = StoredResource>(key: string, touch?: boolean) => {
    const value = originalRead<T>(key, touch);
    if (value && ["Input", "Output"].includes(value.object.kind)) bodies++;
    return value;
  };
  const streams = aide.topics.outputStore.streams, reader = streams.reader.bind(streams);
  let reads = 0;
  streams.reader = (...args) => { reads++; return reader(...args); };
  const response = await fetch(base + "/topics/history?topicId=messages");
  assert.equal(response.status, 200);
  const page = await response.json() as TopicView;
  assert.equal(page.blocks.length, 10);
  assert.ok(page.blocks.every(block => block.lazy && block.content.length <= 120));
  assert.equal(bodies, 0, "Metadata lists never decode Input evidence or Output envelopes");
  assert.equal(reads, 0, "Metadata lists never open Output content streams");
  assert.ok(JSON.stringify(page).length < 12_000);
  assert.doesNotMatch(JSON.stringify(page), /BODY_TAIL|Other Topic secret/);
  const rows = [...page.blocks];
  let before = page.meta.before;
  while (before) {
    const older = await (await fetch(base + "/topics/history?" + new URLSearchParams({ topicId: "messages", before }))).json() as TopicView;
    rows.push(...older.blocks); before = older.meta.before;
  }
  assert.equal(rows.length, 24); assert.equal(new Set(rows.map(row => row.id)).size, 24);
  const output = rows.find(row => row.type === "message")!;
  const query = { topicId: "messages", topicUid: output.lazy!.topicUid, id: output.id, uid: output.lazy!.uid };
  const detailResponse = await fetch(base + "/topics/message?" + new URLSearchParams(query));
  assert.equal(detailResponse.status, 200);
  const detail = await detailResponse.json() as TopicView;
  assert.equal(detail.blocks.filter(block => block.type === "message").length, 1);
  assert.equal(detail.blocks.find(block => block.id === output.id)!.content, body);
  assert.equal(reads, 1, "Only the selected Output stream is opened");
  for (const invalid of [{ ...query, topicUid: "replaced-topic" }, { ...query, uid: "replaced-message" },
    { ...query, id: `input:${other.metadata.name}`, uid: other.metadata.uid }]) {
    assert.equal((await fetch(base + "/topics/message?" + new URLSearchParams(invalid))).status, 404);
  }
  const input = rows.find(row => row.type === "input")!;
  const inputDetail = await (await fetch(base + "/topics/message?" + new URLSearchParams({ ...query, id: input.id, uid: input.lazy!.uid }))).json() as TopicView;
  assert.equal(inputDetail.blocks.find(block => block.id === input.id)!.content, body);
  assert.equal(reads, 1, "Input details do not open other replies");
});
