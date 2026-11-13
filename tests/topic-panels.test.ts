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
